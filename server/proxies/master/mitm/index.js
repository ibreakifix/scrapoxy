'use strict';

const
    events = require('events'),
    tls = require('tls'),
    url = require('url'),
    {ServerResponse} = require('_http_server'),
    {parsers, freeParser} = require('_http_common');

const
    HTTPParser = process.binding('http_parser').HTTPParser;



class Mitm {
    constructor(config) {
        this._config = config;

        this._sharedCreds = tls.createSecureContext({
            key: this._config.key,
            cert: this._config.cert,
        });
    }


    connect(socket, requestCallback) {
        const tlsSocket = new tls.TLSSocket(socket, {
            secureContext: this._sharedCreds,
            isServer: true,
            requestCert: this._config.cert,
            rejectUnauthorized: false,
        });

        tlsSocket.on('secure', () => {
            const parser = this._parse(tlsSocket);

            parser.on('request', (req) => {
                req.url = `https://${req.headers.host}${req.url}`;
                delete req.headers.host;

                const res = new ServerResponse(req);
                res.assignSocket(tlsSocket);

                res.on('finish', () => {
                    res.detachSocket(tlsSocket);

                    process.nextTick(() => {
                        res.emit('close');
                    });

                    tlsSocket.end();
                });

                requestCallback(req, res);
            });

            parser.once('error', () => {
                // TODO: log
                socket.end();
            });
        });

        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    }


    _parse(socket){
        const emitter = new events.EventEmitter();

        const parser = parsers.alloc();
        parser.reinitialize(HTTPParser.REQUEST);
        parser.socket = socket;
        socket.parser = parser;

        parser.maxHeaderPairs = 2000;

        parser.onIncoming = (req) => {
            emitter.emit('request', req);
        };

        socket.on('data', (buffer) => {
            const ret = parser.execute(buffer);
            if(ret instanceof Error){
                emitter.emit('error');

                freeParser(socket.parser, null, socket);
            }
        });

        socket.once('close', () => {
            freeParser(parser);
        });

        return emitter;
    };
}


////////////

module.exports = Mitm;
