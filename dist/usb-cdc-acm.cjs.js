'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var stream = require('stream');
var Debug = _interopDefault(require('debug'));
var usb = _interopDefault(require('usb'));

/* Copyright (c) 2010 - 2018, Nordic Semiconductor ASA
 *
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * 3. Neither the name of Nordic Semiconductor ASA nor the names of its
 *    contributors may be used to endorse or promote products derived from this
 *    software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY, AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL NORDIC SEMICONDUCTOR ASA OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

// Quasi-trivial utility to parse USB descriptors from a Uint8Array
// The first byte in the descriptor is the descriptor length, and they are just
// concatenated together, so something like:
// 5 X X X X 4 X X X 9 X X X X X X X X
// should be splitted into
// 5 X X X X  |  4 X X X   |  9 X X X X X X X X

// Given a Uint8Array, returns an Array of Uint8Array
// Each element of the resulting array is a subarray of the original Uint8Array.
function splitDescriptors(bytes) {
    var descs = [];
    if (!(bytes instanceof Uint8Array)) {
        return descs;
    }
    var len = bytes.length;
    var pointer = 0;

    while (len > 0) {
        var descLen = bytes[pointer];
        if (descLen < 1) {
            throw new Error('invalid descriptor length');
        }
        descs.push(bytes.subarray(pointer, pointer + descLen));
        len -= descLen;
        pointer += descLen;
    }

    // TODO: Consider handling if len !== 0 at this point.

    return descs;
}

/* Copyright (c) 2010 - 2018, Nordic Semiconductor ASA
 *
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * 3. Neither the name of Nordic Semiconductor ASA nor the names of its
 *    contributors may be used to endorse or promote products derived from this
 *    software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY, AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL NORDIC SEMICONDUCTOR ASA OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

// Two debug levels: one for initialization/teardown messages, and one
// for logging all data being sent/recv around
var debugInfo = Debug('usb-cdc-acm:info');
var debugData = Debug('usb-cdc-acm:data');


// Utility function.
// Given an interface, assert that it looks like a CDC management interface
// Specifically, the interface must have only one
// "out" interrupt endpoint, and a CDC Union descriptor.
// Will return boolean `false` if the interface is not valid,
// or an integer number (corresponding to the associated data interface)
function assertCdcInterface(iface) {
    var endpoints = iface.endpoints;
    var descriptor = iface.descriptor;

    if (descriptor.bInterfaceClass !== usb.LIBUSB_CLASS_COMM || // 2, CDC
        descriptor.bInterfaceSubClass !== 2) { // ACM
        return false;
    }

    // Check it has only one endpoint, and of the right kind
    if (endpoints.length !== 1 ||
        endpoints[0].transferType !== usb.LIBUSB_TRANSFER_TYPE_INTERRUPT ||
        endpoints[0].direction !== 'in') {
        return false;
    }

    // node-usb doesn't parse the CDC Union descriptor inside the interface
    // descriptor, so parse and find it manually here.
    var additionalDescriptors = splitDescriptors(descriptor.extra);
    var slaveInterfaceId = false;

    for (var i = 0, l = additionalDescriptors.length; i < l; i += 1) {
        var desc = additionalDescriptors[i];

        // 0x24 = class-specific descriptor. 0x06 = CDC Union descriptor
        if (desc[1] === 0x24 && desc[2] === 6) {
            if (desc[3] !== iface.id) {
                // Master interface should be the current one!!
                return false;
            }
            var assign;
            (assign = desc, slaveInterfaceId = assign[4]); // slaveInterfaceId = desc[4];
        }
    }

    if (slaveInterfaceId === false) {
        // CDC Union descriptor not found, this is not a well-formed USB CDC ACM interface
        return false;
    }

    return (slaveInterfaceId);
}


// Utility function.
// Given an interface, assert that it looks like a CDC data interface
// Specifically, the interface must have only one
// "in" bulk endpoint and one "out" bulk endpoint.
function assertDataInterface(iface) {
    var endpoints = iface.endpoints;

    return (
        // Right class (0x0A)
        iface.descriptor.bInterfaceClass === usb.LIBUSB_CLASS_DATA &&
        // Only two endpoints, and
        endpoints.length === 2 &&
        // both are bulk transfer, and
        endpoints[0].transferType === usb.LIBUSB_TRANSFER_TYPE_BULK &&
        endpoints[1].transferType === usb.LIBUSB_TRANSFER_TYPE_BULK &&
        // their direction (in/out) is different
        endpoints[0].direction !== endpoints[1].direction
    );
}


var UsbCdcAcm = (function (Duplex) {
    function UsbCdcAcm(ifaceCdc, options) {
        var this$1 = this;
        if ( options === void 0 ) options = {};

        var ifaceDataId = assertCdcInterface(ifaceCdc);
        if (ifaceDataId === false) {
            throw new Error('CDC interface is not valid');
        }

        var ifaceData = ifaceCdc.device.interfaces[ifaceDataId];
        if (!assertDataInterface(ifaceData)) {
            throw new Error('Data interface is not valid');
        }

        Duplex.call(this, options);

        this.ifaceCdc = ifaceCdc;
        this.ifaceData = ifaceData;
        this.device = ifaceCdc.device;

        var assign;
        (assign = ifaceCdc.endpoints, this.ctr = assign[0]);

        if (ifaceData.endpoints[0].direction === 'in') {
            var assign$1;
            (assign$1 = ifaceData.endpoints, this.in = assign$1[0], this.out = assign$1[1]);
        } else {
            var assign$2;
            (assign$2 = ifaceData.endpoints, this.out = assign$2[0], this.in = assign$2[1]);
        }

        debugInfo('claiming interfaces');

        this._reattachCdcDriverAtFinal = false;
        this._reattachDataDriverAtFinal = false;
        // Linux/mac need to detach the cdc-acm kernel driver, but
        // windows users did that manually, and libusb-win just throws
        // errors when detaching/attaching kernel drivers.
        if (process.platform !== 'win32') {
            if (ifaceCdc.isKernelDriverActive()) {
                ifaceCdc.detachKernelDriver();
                this._reattachCdcDriverAtFinal = true;
            }

            if (ifaceData.isKernelDriverActive()) {
                ifaceData.detachKernelDriver();
                this._reattachDataDriverAtFinal = true;
            }
        }
        ifaceCdc.claim();
        ifaceData.claim();

        this.ctr.on('data', this._onStatus.bind(this));
        this.ctr.on('error', this._onError.bind(this));
        this.ctr.startPoll();


        // Set baud rate and serial line params,
        // then set the line as active
        this._controlSetLineCoding(options.baudRate || 9600)
            .then(function () { this$1._controlLineState(true); })
            .then(function () { this$1._controlGetLineCoding(); })
            .then(function () {
                this$1.in.on('data', function (data) { return this$1._onData(data); });
                this$1.in.on('error', function (err) { return this$1.emit('error', err); });
                this$1.out.on('error', function (err) { return this$1.emit('error', err); });

                this$1.in.timeout = 1000;
                this$1.out.timeout = 1000;
            });
    }

    if ( Duplex ) UsbCdcAcm.__proto__ = Duplex;
    UsbCdcAcm.prototype = Object.create( Duplex && Duplex.prototype );
    UsbCdcAcm.prototype.constructor = UsbCdcAcm;

    UsbCdcAcm.prototype._read = function _read () {
        debugData('_read');
        if (!this.polling) {
            debugInfo('starting polling');
            this.in.startPoll();
            this.polling = true;
        }
    };

    UsbCdcAcm.prototype._onData = function _onData (data) {
        debugData('_onData ', data);
        var keepReading = this.push(data);
        if (!keepReading) {
            this._stopPolling();
        }
    };

    UsbCdcAcm.prototype._onError = function _onError (err) {
        debugInfo('Error: ', err);
        this.emit('error', err);
        //         throw err;
    };

    UsbCdcAcm.prototype._onStatus = function _onStatus (sts) { // eslint-disable-line class-methods-use-this
        debugInfo('Status: ', sts);
    };

    UsbCdcAcm.prototype._stopPolling = function _stopPolling () {
        debugInfo('_stopPolling');
        if (this.polling) {
            debugInfo('stopping polling');
            this.in.stopPoll();
            this.polling = false;
        }
    };

    UsbCdcAcm.prototype._write = function _write (data, encoding, callback) {
        debugData(("_write " + (data.toString())));

        this.out.transfer(data, callback);
    };

    UsbCdcAcm.prototype._destroy = function _destroy () {
        var this$1 = this;

        debugInfo('_destroy');

        // Set line state as unused, close all resources, release interfaces
        // (waiting until they are released), reattach kernel drivers if they
        // were attached before, then emit a 'close' event.

        this._controlLineState(false)
            .then(function () {
                this$1._stopPolling();
                this$1.ctr.stopPoll();

                this$1.ctr.removeAllListeners();
                this$1.in.removeAllListeners();
                this$1.out.removeAllListeners();

                this$1.ifaceCdc.release(true, function (err) {
                    if (err) { throw err; }
                    this$1.ifaceData.release(true, function (err2) {
                        if (err2) { throw err2; }

                        if (this$1._reattachCdcDriverAtFinal) {
                            this$1.ifaceCdc.attachKernelDriver();
                        }
                        if (this$1._reattachDataDriverAtFinal) {
                            this$1.ifaceData.attachKernelDriver();
                        }

                        debugInfo('All resources released');
                        this$1.emit('close');
                    });
                });
            });
    };


    // Performs a _controlTransfer() to set the line state.
    // Set active to a truthy value to indicate there is something connected to the line,
    // falsy otherwise.
    // Returns a Promise.
    UsbCdcAcm.prototype._controlLineState = function _controlLineState (active) {
        // This is documented in the PSTN doc of the USB spec, section 6.3.12
        return this._controlTransfer(
            0x21, // bmRequestType: [host-to-device, type: class, recipient: iface]
            0x22, // SET_CONTROL_LINE_STATE
            active ? 0x03 : 0x00, // 0x02 "Activate carrier" & 0x01 "DTE is present"
            this.ifaceCdc.id, // interface index
            Buffer.from([]) // No data expected back
        );
    };

    // Performs a _controlTransfer to set the line coding.
    // This includes bitrate, stop bits, parity, and data bits.
    UsbCdcAcm.prototype._controlSetLineCoding = function _controlSetLineCoding (baudRate) {
        if ( baudRate === void 0 ) baudRate = 9600;

        // This is documented in the PSTN doc of the USB spec, section 6.3.10,
        // values for the data structure at the table in 6.3.11.
        var data = Buffer.from([
            0, 0, 0, 0, // Four bytes for the bitrate, will be filled in later.
            0, // Stop bits. 0 means "1 stop bit"
            0, // Parity. 0 means "no parity"
            8 ]);

        data.writeInt32LE(baudRate, 0);

        debugInfo('Setting baud rate to ', baudRate);

        return this._controlTransfer(
            0x21, // bmRequestType: [host-to-device, type: class, recipient: iface]
            0x20, // SET_LINE_CODING
            0x00, // Always zero
            this.ifaceCdc.id, // interface index
            data
        );
    };

    // Performs a _controlTransfer to get the line coding.
    // This includes bitrate, stop bits, parity, and data bits.
    UsbCdcAcm.prototype._controlGetLineCoding = function _controlGetLineCoding () {
        // This is documented in the PSTN doc of the USB spec, section 6.3.11,
        debugInfo('Requesting actual line coding values');

        return this._controlTransfer(
            0xA1, // bmRequestType: [device-to-host, type: class, recipient: iface]
            0x21, // GET_LINE_CODING
            0x00, // Always zero
            this.ifaceCdc.id, // interface index
            7 // Length of data expected back
        ).then(function (data) {
            var baudRate = data.readInt32LE(0);
            var rawStopBits = data.readInt8(4);
            var rawParity = data.readInt8(5);
            var dataBits = data.readInt8(6);

            var stopBits;
            var parity;
            switch (rawStopBits) {
                case 0: stopBits = 1; break;
                case 1: stopBits = 1.5; break;
                case 2: stopBits = 2; break;
                default: throw new Error('Invalid value for stop bits received (during a GET_LINE_CODING request)');
            }
            switch (rawParity) {
                case 0: parity = 'none'; break;
                case 1: parity = 'odd'; break;
                case 2: parity = 'even'; break;
                case 3: parity = 'mark'; break;
                case 4: parity = 'space'; break;
                default: throw new Error('Invalid value for parity received (during a GET_LINE_CODING request)');
            }

            debugInfo('Got line coding: ', data);
            debugInfo('Reported baud rate: ', baudRate);
            debugInfo('Reported stop bits: ', stopBits);
            debugInfo('Reported parity: ', parity);
            debugInfo('Reported data bits: ', dataBits);

            return data;
        });
    };

    // The device's controlTransfer, wrapped as a Promise
    UsbCdcAcm.prototype._controlTransfer = function _controlTransfer (bmRequestType, bRequest, wValue, wIndex, dataOrLength) {
        var this$1 = this;

        return new Promise(function (res, rej) {
            this$1.device.controlTransfer(
                bmRequestType,
                bRequest,
                wValue,
                wIndex,
                dataOrLength,
                (function (err, data) { return (err ? rej(err) : res(data)); })
            );
        });
    };


    // Given an instance of Device (from the 'usb' library), opens it, looks through
    // its interfaces, and creates an instance of UsbStream per interface which
    // looks like a CDC ACM control interface (having the right descriptor and endpoints).
    //
    // The given Device must be already open()ed. Conversely, it has to be close()d
    // when the stream is no longer used, or if this method throws an error.
    //
    // Returns an array of instances of UsbCdcAcm.
    UsbCdcAcm.fromUsbDevice = function fromUsbDevice (device, options) {
        if ( options === void 0 ) options = {};

        var ifaces = device.interfaces;

        for (var i = 0, l = ifaces.length; i < l; i += 1) {
            var iface = ifaces[i];

            if (assertCdcInterface(iface) !== false) {
                return new UsbCdcAcm(iface, options);
            }
        }

        throw new Error('No valid CDC interfaces found in USB device');
    };

    return UsbCdcAcm;
}(stream.Duplex));

module.exports = UsbCdcAcm;
//# sourceMappingURL=usb-cdc-acm.cjs.js.map
