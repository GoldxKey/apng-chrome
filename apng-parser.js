(function() {
    var global = (function() {
        return this;
    })(), D = Deferred;

    var PNG_SIGNATURE_BYTES = new Uint8Array(new ArrayBuffer(8));
    PNG_SIGNATURE_BYTES.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    var BlobBuilder = (global.BlobBuilder || global.WebKitBlobBuilder);
    var URL = (global.URL || global.webkitURL);

    var readDWord = function(bytes, off) {
        var x = 0;
        for (var i = 0; i < 4; i++) x += (bytes[i + off] << ((3 - i) * 8));
        return x;
    };
    var readWord = function(bytes, off) {
        var x = 0;
        for (var i = 0; i < 2; i++) x += (bytes[i + off] << ((1 - i) * 8));
        return x;
    };
    var readByte = function(bytes, off) {
        return bytes[off];
    };
    var readString = function(bytes, off, length) {
        var chars = Array.prototype.slice.call(bytes.subarray(off, off + length));
        return String.fromCharCode.apply(String, chars);
    };

    var makeDWordArray = function(x) {
        return [(x >> 24) & 0xff, (x >> 16) & 0xff, (x >> 8) & 0xff, x & 0xff];
    };
    var makeStringArray = function(x) {
        var res = [];
        for (var i = 0; i < x.length; i++) res.push(x.charCodeAt(i));
        return res;
    };
    var makeChunkBytes = function(/* string */ type, /* bytes */ dataBytes) {
        var crcLen = type.length + dataBytes.length;
        var bytes = new Uint8Array(new ArrayBuffer(crcLen + 8));
        bytes.set(makeDWordArray(dataBytes.length), 0);
        bytes.set(makeStringArray(type), 4);
        bytes.set(dataBytes, 8);
        var crc = crc32(bytes, 4, crcLen);
        bytes.set(makeDWordArray(crc), crcLen + 4);
        return bytes;
    };

    var subBuffer = function(bytes, start, length) {
        var a = new Uint8Array(new ArrayBuffer(length));
        a.set(bytes.subarray(start, start + length));
        return a.buffer;
    };


    var parseChunks = function(bytes, callback) {
        var off = 8;
        do {
            var length = readDWord(bytes, off);
            var type = readString(bytes, off + 4, 4);
            var res = callback(type, bytes, off, length);
            off += 12 + length;
        } while(res !== false && type != "IEND" && off < bytes.length);
    };

    global.parseAPNG = function(bytes) {
        var d = new D();

        for (var i = 0; i < PNG_SIGNATURE_BYTES.length; i++) {
            if (PNG_SIGNATURE_BYTES[i] != bytes[i]) {
                d.reject("Invalid PNG file signature");
                return d.promise();
            }
        }

        // быстрая проверка анимированности
        var isAnimated = false;
        parseChunks(bytes, function(type) {
            if (type == "acTL") {
                isAnimated = true;
                return false;
            }
        });
        if (!isAnimated) {
            d.reject("Not an animated PNG");
            return d.promise();
        }

        var
                preDataBuilder = new BlobBuilder(),
                postDataBuilder = new BlobBuilder(),
                headerDataBytes = null,
                frame = null,
                aPNG = {
                    width:  0,
                    height: 0,
                    numPlays:   0,
                    playTime:   0,
                    frames:     []
                };

        parseChunks(bytes, function(type, bytes, off, length) {
            switch (type) {
                case "IHDR":
                    headerDataBytes = bytes.subarray(off + 8, off + 8 + length);
                    aPNG.width = readDWord(bytes, off + 8);
                    aPNG.height = readDWord(bytes, off + 12);
                    break;
                case "acTL":
                    aPNG.numPlays = readDWord(bytes, off + 8 + 4);
                    break;
                case "fcTL":
                    if (frame) aPNG.frames.push(frame);
                    frame = {};
                    frame.width     = readDWord(bytes, off + 8 + 4);
                    frame.height    = readDWord(bytes, off + 8 + 8);
                    frame.left      = readDWord(bytes, off + 8 + 12);
                    frame.top       = readDWord(bytes, off + 8 + 16);
                    var delayN      = readWord(bytes, off + 8 + 20);
                    var delayD      = readWord(bytes, off + 8 + 22);
                    if (delayD == 0) delayD = 100;
                    frame.delay = 1000 * delayN / delayD;
                    // see http://mxr.mozilla.org/mozilla/source/gfx/src/shared/gfxImageFrame.cpp#343
                    if (frame.delay <= 10) frame.delay = 100;
                    aPNG.playTime += frame.delay;
                    frame.disposeOp = readByte(bytes, off + 8 + 24);
                    frame.blendOp   = readByte(bytes, off + 8 + 25);
                    frame.dataParts = [];
                    break;
                case "fdAT":
                    if (frame) frame.dataParts.push(bytes.subarray(off + 8 + 4, off + 8 + length));
                    break;
                case "IDAT":
                    if (frame) frame.dataParts.push(bytes.subarray(off + 8, off + 8 + length));
                    break;
                case "IEND":
                    postDataBuilder.append(subBuffer(bytes, off, 12 + length));
                    break;
                default:
                    preDataBuilder.append(subBuffer(bytes, off, 12 + length));
            }
        });
        if (frame) aPNG.frames.push(frame);

        if (!aPNG.frames.length) {
            d.reject("Not an animated PNG");
            return d.promise();
        }

        // Собираем кадры
        var createdUrls = 0;
        for (var f = 0; f < aPNG.frames.length; f++) {
            frame = aPNG.frames[f];

            var bb = new BlobBuilder();
            bb.append(PNG_SIGNATURE_BYTES.buffer);
            headerDataBytes.set(makeDWordArray(frame.width), 0);
            headerDataBytes.set(makeDWordArray(frame.height), 4);
            bb.append(makeChunkBytes("IHDR", headerDataBytes).buffer);
            bb.append(preDataBuilder.getBlob());
            for (var j = 0; j < frame.dataParts.length; j++)
                bb.append(makeChunkBytes("IDAT", frame.dataParts[j]).buffer);
            bb.append(postDataBuilder.getBlob());
            //frame.url = URL.createObjectURL(bb.getBlob("image/png"));
            var reader = new FileReader();
            (function(frame) {
                reader.onload = function(e) {
                    frame.url = e.target.result;
                    createdUrls++;
                    if (createdUrls == aPNG.frames.length) d.resolve(aPNG);
                };
            })(frame);
            reader.readAsDataURL(bb.getBlob("image/png"));
            delete frame.dataParts;
            bb = null;
        }
        return d.promise();
    };

})();