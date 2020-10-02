// Idea from: https://gist.github.com/matthias-christen/6beb3b4dda26bd6a221d

'use strict';

const http = require('http'),
    tls = require('tls'),
    util = require('util');


module.exports = class ProxyAgent extends http.Agent {
    constructor(opts) {
        super();

        this._agent = opts.agent;
    }


    addRequest(req, options) {
        // Legacy API: addRequest(req, host, port, path)
        if (typeof options === 'string') {
            options = {
                host: options,
                port: arguments[2],
                path: arguments[3],
            };
        }

        const name = this.getName(options);
        if (!this.sockets[name]) {
            this.sockets[name] = [];
        }

        if (this.sockets[name].length < this.maxSockets) {
            this._createSocket(req, options, (err, s) => {
                if (err) {
                    return req.emit('error', err);
                }

                req.onSocket(s);
            });
        }
        else {
            if (!this.requests[name]) {
                this.requests[name] = [];
            }

            this.requests[name].push(req);
        }
    }


    _createConnection(opts, callback) {
        const proxyOpts = {
            host: opts.proxy.hostname,
            port: opts.proxy.port,
            method: 'CONNECT',
            path: `${opts.hostname}:${opts.port}`,
            agent: this._agent,
            headers: {},
        };

        if (opts.proxy.username && opts.proxy.password) {
            const usernamePasswordB64 = new Buffer(`${opts.proxy.username}:${opts.proxy.password}`).toString('base64');
            proxyOpts.headers['proxy-authorization'] = `Basic ${usernamePasswordB64}`;
        }

        const req = http.request(proxyOpts);

        req.on('error', (err) => callback(err));

        req.on('connect', (res, socket) => {
            socket.on('error', (err) => callback(err));

            if (!opts.ssl) {
                return callback(false, socket);
            }

            const cts = tls.connect({
                host: opts.hostname,
                servername: opts.hostname,
                socket,
            }, () => callback(false, cts));

            cts.on('error', (err) => callback(err));
        });

        req.end();
    }


    _createSocket(req, options, callback) {
        options = util._extend({}, options);
        options = util._extend(options, this.options);

        options.servername = options.host;
        if (req) {
            const hostHeader = req.getHeader('host');
            if (hostHeader) {
                options.servername = hostHeader.replace(/:.*$/, '');
            }
        }

        const name = this.getName(options);

        options.encoding = void 0;

        this._createConnection(options, (err, s) => {
            const self = this;

            if (err) {
                return callback(err);
            }

            if (!this.sockets[name]) {
                this.sockets[name] = [];
            }
            this.sockets[name].push(s);

            s.on('free', onFree);
            s.on('close', onClose);
            s.on('agentRemove', onRemove);

            return callback(false, s);


            ////////////

            function onFree() {
                self.emit('free', s, options);
            }

            function onClose() {
                self._removeSocket(s, options);
            }

            function onRemove() {
                self._removeSocket(s, options);

                s.removeListener('close', onClose);
                s.removeListener('free', onFree);
                s.removeListener('agentRemove', onRemove);
            }
        });
    }


    _removeSocket(socket, options) {
        const name = this.getName(options);
        const sets = [this.sockets];

        if (socket.destroyed) {
            sets.push(this.freeSockets);
        }

        for (const sockets of sets) {
            if (sockets[name]) {
                const index = sockets[name].indexOf(socket);
                if (index !== -1) {
                    sockets[name].splice(index, 1);

                    // Don't leak
                    if (sockets[name].length === 0) {
                        delete sockets[name];
                    }
                }
            }
        }

        if (this.requests[name] && this.requests[name].length) {
            const req = this.requests[name][0];

            this._createSocket(req, options, (err, s) => {
                if (err) {
                    return req.emit('error', err);
                }

                s.emit('free');
            });
        }
    }
};
