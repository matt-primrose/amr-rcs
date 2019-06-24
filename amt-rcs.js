/*
Copyright 2019 Intel Corporation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/**
* @module amt-rcs
*/

/** 
* @description Intel(r) AMT Remote Configuration Service
* @author Matt Primrose
* @version v0.2.0
* @dependencies node-forge, ws
*/

'use strict'
const forge = require('node-forge');
const fs = require('fs');
const crypto = require('crypto');
const websocket = require('./wsserver');
const RCSMessageProtocolVersion = 1; // RCS Message Protocol Version.
/**

 * @constructor
 * @description Creates and returns an instance of the RCS object
 * @param {JSON} config RCS configuration JSON object.
 * @param {Object} ws (Optional) WebSocket connection.
 * @param {Object} logger (Optional) Logging callback.
 * @param {Object} db (Optional) Database callback.
 * @returns {Object} RCS service object
 */
function CreateRcs(config, ws, logger, db) {

    var obj = new Object();    
    obj.rcsConfig = config;
    obj.wsServer = ws;
    obj.logger = logger;
    obj.db = db;
    obj.connection = {};
    obj.output = function (msg) { console.log((new Date()) + ' ' + msg); if (obj.logger !== undefined) { obj.logger(msg); } }

    /**
     * @description Main function to start the RCS service
     */
    obj.start = function() { obj.startWebSocketServer(); }

    /**
    * @description Start the WebSocket Server
    */
    obj.startWebSocketServer = function () {
        obj.output('Starting RCS Server...');
        if (obj.wsServer === undefined) { // Start the basic websocket server included in amt-rcs
            obj.wsServer = websocket(obj.rcsConfig.WSConfiguration.WebSocketPort, obj.rcsConfig.WSConfiguration.WebSocketTLS, obj.rcsConfig.WSConfiguration.WebSocketCertificate, obj.rcsConfig.WSConfiguration.WebSocketCertificateKey, obj.wsConnectionHandler);
            obj.output('RCS Server running on port: ' + obj.rcsConfig.WSConfiguration.WebSocketPort);
        } else {
            // Handle any custom websocket initialization here
        }
    }

    /**
     * @description Callback from WebSocket Server to handle incomming messages
     * @param {string} event The event type coming from websocket
     * @param {string|buffer|object} message The message coming in over the websocket
     * @param {number} index The connection index of the connected device
     */
    obj.wsConnectionHandler = function(event, message, index) {
        if (obj.connection[index] == undefined) { obj.connection[index] = {}; }
        // Parse the incoming JSON message and figure out what type data message is coming in (string, buffer, or object)
        if (typeof message == 'string') {
            try { message = JSON.parse(message); } catch (e) { var msg = { "errorText": "Invalid message from client" }; obj.output(msg.errorText); obj.sendMessage(index, msg);}
            if (message.action) { event = message.action; }
        }
        switch (event) {
            // Handles 'cmd' messages
            case 'acmactivate':
                if (message.profile) { obj.connection[index]["profile"] = message.profile; }
                if (message.fqdn) { obj.connection[index]["dnsSuffix"] = message.fqdn; }
                if (message.realm) { obj.connection[index]["digestRealm"] = message.realm; }
                if (message.nonce) { obj.connection[index]["fwNonce"] = Buffer.from(message.nonce, 'base64'); }
                if (message.hashes) { obj.connection[index]["certHashes"] = message.hashes; }
                if (message.uuid) { obj.connection[index]["amtGuid"] = message.uuid; }
                if (obj.db) { obj.db(obj.connection[index]); }
                var rcsObj = obj.remoteConfiguration(obj.connection[index].fwNonce, index);
                if (rcsObj.errorText) { obj.output(rcsObj.errorText); sendMessage(index, rcsObj); }
                obj.sendMessage(index, rcsObj);
                break;
            // Handles 'error' type messages
            case 'error':
                obj.output('AMT Device ' + index + ' received "error" message: ' + message.data);
                break;
            // Handles 'close' type messages when the socket closes
            case 'close':
                obj.output(message.data);
                delete obj.connection[index];
                break;
            // Handles 'finish' type messages to indicate when the configuration process has completed (success or failure)
            case 'finish':
                obj.output('AMT Configuration of device ' + index + ' ' + message.data);
                break;
            // Catches anything that falls through the cracks.  Shouldn't ever see this message
            default:
                obj.output('Detected a new websocket message type (need to handle this): ' + event);
                break;
        }
    }

    /**
     * @description Main function for handling the remote configuration tasks.  Needs the fwNonce from AMT to start and returns the configuration object to be passed down to AMT
     * @param {buffer} fwNonce AMT firmware nonce as a buffer
     * @param {number} cindex Connection index of the device sending the message
     * @returns {object} returns the configuration object to be passed down to AMT
     */
    obj.remoteConfiguration = function(fwNonce, cindex) {
        var rcsObj = {};
        rcsObj["action"] = 'acmactivate';
        // Verify we have a valid connection index and error out if we do not
        if (!obj.connection[cindex]) { rcsObj = { errorText: "WebSocket connection not found in list of connected clients." }; return rcsObj; }
        // Gets all of the certificate information needed by AMT
        var dnsSuffix = null;
        // Check the connection array if the dnsSuffix is set for this connection.
        if (obj.connection[cindex].dnsSuffix) { dnsSuffix = obj.connection[cindex].dnsSuffix; }
        rcsObj.certs = obj.getProvisioningCertObj(dnsSuffix, cindex);
        // Check if we got an error while getting the provisioning cert object
        if (rcsObj.certs.errorText) { return rcsObj.certs; }
        var privateKey = rcsObj.certs.privateKey;
        // Removes the private key information from the certificate object - don't send private key to the client!!
        delete rcsObj.certs.privateKey;
        // Create a one time nonce that allows AMT to verify the digital signature of the management console performing the provisioning
        rcsObj.nonce = generateNonce();
        // Need to create a new array so we can concatinate both nonces (fwNonce first, Nonce second)
        var arr = [fwNonce, rcsObj.nonce];
        // mcNonce needs to be in base64 format to send over WebSocket connection
        rcsObj.nonce = rcsObj.nonce.toString('base64');
        // Then we need to sign the concatinated nonce with the private key of the provisioning certificate and encode as base64.
        rcsObj.signature = signString(Buffer.concat(arr), privateKey);
        if (rcsObj.signature.errorText) { return rcsObj.signature; }
        // Grab the AMT password from the specified profile in rcsConfig file and add that to the rcsObj so we can set the new MEBx password
        var amtPassword
        if (!obj.connection[cindex].profile || obj.connection[cindex].profile == "" || obj.connection[cindex].profile == null) { amtPassword = obj.rcsConfig.AMTConfigurations[0].AMTPassword; }  // If profile is not specified, set the profile to the first profile in rcs-config.json
        else {
            var match = false;
            for (var x = 0; x < obj.rcsConfig.AMTConfigurations.length; x++) {
                if (obj.rcsConfig.AMTConfigurations[x].ProfileName == obj.connection[cindex].profile) {
                    // Got a match, set AMT Profile Password in rcsObj
                    amtPassword = obj.rcsConfig.AMTConfigurations[x].AMTPassword;
                    match = true;
                    break;
                }
            }
            if (!match) {
                // An AMT profile was specified but it doesn't match any of the profile names in rcs-config.json.  Send warning to console and default to first AMT profile listed.
                obj.output('Specified AMT profile name does not match list of available AMT profiles.');
                return { errorText: "Specified AMT profile name does not match list of available AMT profiles." };
            }
        }
        var data = 'admin:' + obj.connection[cindex].digestRealm + ':' + amtPassword;
        rcsObj.password = crypto.createHash('md5').update(data).digest('hex');
        rcsObj.profileScript = null;
        if (obj.rcsConfig.AMTConfigurations[cindex].ConfigurationScript !== null && obj.rcsConfig.AMTConfigurations[cindex].ConfigurationScript !== "") {
            try { rcsObj.profileScript = fs.readFileSync(obj.rcsConfig.AMTConfigurations[cindex].ConfigurationScript, 'utf8'); }
            catch (e) { rcsObj.profileScript = null; }
        }
        return rcsObj;
    }

    /**
     * @description Disect the provisioning certificate
     * @param {string} domain DNS Suffix of AMT device
     * @returns {object} Returns the provisioning certificate object
     */
    obj.getProvisioningCertObj = function(domain, index) {
        var cert, certpass;
        if (domain == null || domain == '') {
            // If no domain is specified, return error.
            return { errorText: "AMT domain suffix not specified." };
        } else {
            var match = false;
            for (var x = 0; x < obj.rcsConfig.AMTDomains.length; x++) {
                if (obj.rcsConfig.AMTDomains[x].DomainSuffix == domain) {
                    // Got a match, set AMT Provisioning certificate and key
                    cert = obj.rcsConfig.AMTDomains[x].ProvisioningCert;
                    certpass = obj.rcsConfig.AMTDomains[x].ProvisioningCertPassword;
                    match = true;
                    break;
                }
            }
            if (!match) {
                // An AMT domain suffix was specified but it doesn't match any of the domain suffix specified in rcs-config.json.
                obj.output('Specified AMT domain suffix does not match list of available AMT domain suffixes.');
                return { errorText: "Specified AMT domain suffix does not match list of available AMT domain suffixes." };
            }
        }
        // Verify that the certificate path points to a file that exists
        var certFound = false;
        try {
            if (fs.existsSync(cert)) {
                certFound = true;
            }
        } catch (e) { }
        if (certFound == false) {
            return { errorText: "AMT Provisioning Certificate not found on server" };
        }
        // convert the certificate pfx to an object
        var pfxobj = convertPfxToObject(cert, certpass);
        if (pfxobj.errorText) { return pfxobj; }
        // return the certificate chain pems and private key
        return obj.dumpPfx(pfxobj, index);
    }



    /**
    * @description Pulls the provisioning certificate apart and exports each PEM for injecting into AMT.  Only supports certificate chains up to 4 certificates long
    * @param {object} pfxobj Certificate object from convertPfxToObject function
    * @returns {object} Returns provisioning certificiate object with certificate chain in proper order
    */
    obj.dumpPfx = function(pfxobj, index) {
        var provisioningCertificateObj = {};
        var interObj = [];
        var leaf = {};
        var root = {};
        if (pfxobj) {
            var fingerprint;
            if (pfxobj.certs && Array.isArray(pfxobj.certs)) {
                for (var i = 0; i < pfxobj.certs.length; i++) {
                    var cert = pfxobj.certs[i];
                    var pem = forge.pki.certificateToPem(cert);
                    //Need to trim off the BEGIN and END so we just have the raw pem
                    pem = pem.replace('-----BEGIN CERTIFICATE-----', '');
                    pem = pem.replace('-----END CERTIFICATE-----', '');
                    // pem = pem.replace(/(\r\n|\n|\r)/g, '');
                    // Index 0 = Leaf, Root subject.hash will match issuer.hash, rest are Intermediate.
                    if (i == 0) {
                        leaf['pem'] = pem;
                        leaf['subject'] = cert.subject.hash;
                        leaf['issuer'] = cert.issuer.hash;
                    }
                    else if (cert.subject.hash == cert.issuer.hash) {
                        root['pem'] = pem;
                        root['subject'] = cert.subject.hash;
                        root['issuer'] = cert.issuer.hash;
                        var der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
                        var md = forge.md.sha256.create();
                        md.update(der);
                        fingerprint = md.digest().toHex().toUpperCase();
                    }
                    else {
                        interObj.push({ 'pem': pem, 'subject': cert.subject.hash, 'issuer': cert.issuer.hash });
                    }
                }
            }
            // Need to put the certificate PEMs in the correct order before sending to AMT.  
            // This currently only supports certificate chains that are no more than 4 certificates long
            provisioningCertificateObj['certChain'] = [];
            // Leaf PEM is first
            provisioningCertificateObj.certChain.push(leaf.pem);
            // Need to figure out which Intermediate PEM is next to the Leaf PEM
            for (var k = 0; k < interObj.length; k++) {
                if (!sortCertificate(interObj[k], root)) {
                    provisioningCertificateObj.certChain.push(interObj[k].pem);
                }
            }
            // Need to figure out which Intermediate PEM is next to the Root PEM
            for (var l = 0; l < interObj.length; l++) {
                if (sortCertificate(interObj[l], root)) {
                    provisioningCertificateObj.certChain.push(interObj[l].pem);
                }
            }
            // Root PEM goes in last
            provisioningCertificateObj.certChain.push(root.pem);
            if (pfxobj.keys && Array.isArray(pfxobj.keys)) {
                for (var i = 0; i < pfxobj.keys.length; i++) {
                    var key = pfxobj.keys[i];
                    //Just need the key in key format for signing.  Keeping the private key in memory only.
                    provisioningCertificateObj['privateKey'] = key;
                }
            }
            // Check that provisioning certificate root matches one of the trusted roots from AMT
            for (var x = 0; x < obj.connection[index].certHashes.length; x++) {
                if (obj.connection[index].certHashes[x].certificateHash == fingerprint) {
                    return provisioningCertificateObj;
                }
            }
            return { errorText: "Provisioning Certificate doesn't match any trusted certificates from AMT" };
        }
    }
    
    /**
    * @description Sends messages to WebSocket server using RCS message protocol
    * @description Message Protocol: JSON: { version: int, status: "ok"|"error", event: EVENT_NAME, data: OBJ|Buffer|String }
    * @param {number} index Index of the device connected to the websocket server
    * @param {string} status OK|Error status message type
    * @param {string} event Event type { cmd, message, error, close, finish }
    * @param {string|buffer|object} message Message blob going to device
    */
    obj.sendMessage = function(index, message) {
        if (obj.wsServer == null) { obj.output('WebSocket Server not initialized.'); }
        if (status == null) { status = 'ok'; }
        message.version = RCSMessageProtocolVersion;
        message.status = status;
        obj.wsServer.sendMessage(index, message);
    }

    return obj;
}
module.exports = CreateRcs;

/**
 * @description Extracts the provisioning certificate into an object for later manipulation
 * @param {string} pfxpath Path to provisioning certificate
 * @param {string} passphrase Password to open provisioning certificate
 * @returns {object} Object containing cert pems and private key
 */
function convertPfxToObject(pfxpath, passphrase) {
    var pfx_out = { certs: [], keys: [] };
    var pfxbuf = fs.readFileSync(pfxpath);
    var pfxb64 = Buffer.from(pfxbuf).toString('base64');
    var pfxder = forge.util.decode64(pfxb64);
    var asn = forge.asn1.fromDer(pfxder);
    var pfx;
    try {
        pfx = forge.pkcs12.pkcs12FromAsn1(asn, true, passphrase);
    } catch (e) {
        return { errorText: "Decrypting provisining certificate failed." };
    }
    // Get the certs from certbags
    var bags = pfx.getBags({ bagType: forge.pki.oids.certBag });
    for (var i = 0; i < bags[forge.pki.oids.certBag].length; i++) {
        // dump cert into DER
        var cert = bags[forge.pki.oids.certBag][i];
        pfx_out.certs.push(cert.cert);
    }
    // get shrouded key from key bags
    bags = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    for (var i = 0; i < bags[forge.pki.oids.pkcs8ShroudedKeyBag].length; i++) {
        // dump cert into DER
        var cert = bags[forge.pki.oids.pkcs8ShroudedKeyBag][i];
        pfx_out.keys.push(cert.key);
    }
    return pfx_out;
}

/**
* @description Signs the concatinated nonce with the private key of the provisioning certificate and encodes as base64
* @param {string} message Message to be signed
* @param {string} key Private key of provisioning certificate
* @returns {string} Returns the signed string
*/
function signString(message, key) {
    try {
        var crypto = require('crypto');
        var signer = crypto.createSign('sha256');
        signer.update(message);
        var sign = signer.sign(forge.pki.privateKeyToPem(key), 'base64');
        return sign;
    } catch (e) {
        return { errorText: "Unable to create Digital Signature" };
    }

}

/**
* @description Verification check that the digital signature is correct.  Only used for debug
* @param {string} message Message to be checked
* @param {cert} cert Certificate used to sign
* @param {string} sign Signature used to sign
* @returns {boolean} True = pass, False = fail
*/
function verifyString(message, cert, sign) {
    var crypto = require('crypto');
    var verify = crypto.createVerify('sha256');
    verify.update(message);
    var ver = verify.verify(forge.pki.certificateToPem(cert), sign, 'base64');
    return ver;
}

/**
* @description Generates the console nonce used validate the console.  AMT only accepts a nonce that is 20 bytes long of random data
* @returns {buffer} Returns console nonce used to verify RCS server to AMT
*/
function generateNonce() { var nonce = Buffer.from(crypto.randomBytes(20), 0, 20); return nonce; }

/**
 * @description Sorts the intermediate certificates to properly order the certificate chain
 * @param {Object} intermediate
 * @param {Object} root
 * @returns {Boolean} Returns true if issuer is from root.  Returns false if issuer is not from root.
 */
function sortCertificate(intermediate, root) {
    if (intermediate.issuer == root.subject) {
        return true;
    } else {
        return false;
    }
}