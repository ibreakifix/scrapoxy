'use strict';

const _ = require('lodash'),
    EventEmitter = require('events').EventEmitter,
    InstanceModel = require('./instance.model'),
    pinger = require('../../common/pinger'),
    useragent = require('./useragent'),
    winston = require('winston');


module.exports = class Instance extends EventEmitter {
    constructor(manager, stats, provider, config) {
        super();

        const self = this;

        self._manager = manager;
        self._stats = stats;
        self._provider = provider;
        self._config = config;

        self._model = void 0;
        self._removing = false;
        self._alive = false;
        self._aliveCount = void 0;
        self._rqCount = 0;
        self._useragent = useragent.generateBrowser();


        // Check is alive
        self.on('status:updated', (newstatus) => {
            // Alive
            if (newstatus === InstanceModel.STARTED) {
                // Start monitor
                winston.debug('[Instance/%s] checkAlive every %d secs', self._model.name, self._config.checkAliveDelay);
                self._checkAliveTimeout = setInterval(() => {
                    winston.debug('[Instance/%s] checkAlive: %s / %s', self._model.name, self._alive, self._aliveCount ? self._aliveCount : '-');

                    pinger.ping(self._model.address)
                        .then(() => {
                            self._changeAlive(true);
                            self._aliveCount = void 0;
                        })
                        .catch(() => self._changeAlive(false));
                }, self._config.checkAliveDelay);
            }
            else {
                // Stop monitor
                if (self._checkAliveTimeout) {
                    clearInterval(self._checkAliveTimeout);
                    self._checkAliveTimeout = void 0;
                }

                // Set alive status
                self._changeAlive(false);
            }
        });

        // Autorestart
        self.on('status:updated', (newstatus) => {
            // Alive
            if (newstatus === InstanceModel.STARTED) {
                const delay = getRandomDelay(self._config.autorestart.minDelay, self._config.autorestart.maxDelay);
                winston.debug('[Instance/%s] autorestart in %d secs', self._model.name, delay);
                self._checkRestartTimeout = setTimeout(autorestart, delay);
            }
            else if (self._checkRestartTimeout) {
                clearTimeout(self._checkRestartTimeout);
                self._checkRestartTimeout = void 0;
            }
        });

        // Remove instance on error
        self.on('status:updated', (newstatus) => {
            // Error
            if (newstatus === InstanceModel.ERROR) {
                self._provider.removeInstance(self._model)
                    .catch((err) => {
                        winston.error('[Instance/%s] Error: Instance has an error status:', self._model.name, err);
                    });
            }
        });

        // Restart instance if stopped
        self.on('status:updated', (newstatus) => {
            // Restart if stopped
            if (newstatus === InstanceModel.STOPPED) {
                self._provider.startInstance(self._model)
                    .catch((err) => {
                        winston.error('[Instance/%s] Error: Cannot restart stopped instance:', self._model.name, err);
                    });
            }
        });

        // Count stopped instances
        self.on('alive:updated', (alive) => {
            if (!alive) {
                self._stats.countRequests(self._rqCount);
                self._rqCount = 0;
            }
        });

        // Remove crashed instance
        self.on('alive:updated', (alive) => {
            // Crash timer
            if (alive) {
                winston.debug('[Instance/%s] Instance is alive. Remove crash timer', self._model.name);
                if (self._checkStopIfCrashedTimeout) {
                    clearTimeout(self._checkStopIfCrashedTimeout);
                    self._checkStopIfCrashedTimeout = void 0;
                }
            }
            else {
                winston.debug('[Instance/%s] Instance is down. Crash timer starts', self._model.name);
                self._checkStopIfCrashedTimeout = setTimeout(() => {
                    winston.debug('[Instance/%s] stopIfCrashed', self._model.name);

                    self.remove()
                        .catch((err) => {
                            winston.error('[Instance/%s] Error: Cannot remove running crashed instance:', self._model.name, err);
                        });
                }, self._config.stopIfCrashedDelay);
            }
        });


        ////////////

        function autorestart() {
            winston.debug('[Instance/%s] autorestart', self._model.name);

            if (self._model.status === InstanceModel.STARTED) {
                if (self._manager.aliveInstances.length > 1) {
                    self.remove()
                        .catch((err) => {
                            winston.error('[Instance/%s] Error: Cannot remove started instance for autorestart:', self._model.name, err);
                        });
                }
                else {
                    const delay = Math.floor(
                        self._config.autorestart.minDelay +
                        Math.random() * (self._config.autorestart.maxDelay - self._config.autorestart.minDelay)
                    );

                    winston.debug('[Instance/%s] autorestart cancelled (only 1 instance). restarting in %d secs...', self._model.name, delay);

                    self._checkRestartTimeout = setTimeout(autorestart, delay);
                }
            }
        }
    }


    get name() {
        return this._model.name;
    }


    get model() {
        return this._model;
    }

    set model(model) {
        const oldstatus = this._model ? this._model.status : void 0;

        this._model = model;

        if (this._model.status !== oldstatus) {
            this.emit('status:updated', this._model.status, oldstatus);
        }
    }


    get proxyParameters() {
        const address = this._model.address;

        return {
            'hostname': address.hostname,
            'port': address.port,
            'username': this._config.username,
            'password': this._config.password,
        };
    }


    get stats() {
        return _.merge({}, this._model.stats, {
            alive: this._alive,
            useragent: this._useragent,
        });
    }


    get removing() {
        return this._removing;
    }


    removedFromManager() {
        this._model.status = InstanceModel.REMOVED;

        this.emit('status:updated', InstanceModel.REMOVED, this._model.status);
    }


    remove() {
        this._removing = true;
        this._changeAlive(false);

        return this._provider.removeInstance(this._model);
    }


    updateRequestHeaders(headers) {
        //Allow override of UA randomizer when UA is set manually.
        if(!headers['user-agent']){
         headers['user-agent'] = this._useragent;
        }

        //Fix CURL Setting Proxy-Connection Header
        delete headers['proxy-connection'];

        if (this._config.addProxyNameInRequest) {
            headers['x-cache-proxyname'] = this.name;
        }
        else {
            delete headers['x-cache-proxyname'];
        }
    }


    updateResponseHeaders(headers) {
        headers['x-cache-proxyname'] = this.name;
    }


    incrRequest() {
        ++this._rqCount;
    }


    toString() {
        return this._model.toString();
    }


    _changeAlive(alive) {
        winston.debug('[Instance/%s] changeAlive: %s => %s', this._model.name, this._alive, alive);

        if (this._alive !== alive) {
            this._alive = alive;

            this.emit('alive:updated', alive);
        }
    }
};


////////////

function getRandomDelay(min, max) {
    return Math.floor(min + Math.random() * (max - min));
}
