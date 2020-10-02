'use strict';

const Promise = require('bluebird'),
    request = require('request'),
    winston = require('winston');


module.exports = {
    ping,
    pingRetry,
    waitPing,
};


////////////

function ping(options) {
    if (!options || !options.hostname || !options.port) {
        return Promise.reject(new Error('[ping] should have hostname and port'));
    }

    winston.debug('[Pinger] ping: hostname=%s / port=%d', options.hostname, options.port);

    const opts = {
        method: 'GET',
        url: `http://${options.hostname}:${options.port}/ping`,
        timeout: options.timeout || 5000, // Set default timeout to 5s
    };

    return new Promise((resolve, reject) => {
        request(opts, (err, res, body) => {
            if (err) {
                return reject(err);
            }

            if (res.statusCode !== 200) {
                return reject(body);
            }

            return resolve(body);
        });
    });
}


function pingRetry(options, retry, retryDelay) {
    if (!options || !options.hostname || !options.port || !retryDelay) {
        throw new Error('[pingRetry] should have hostname, port, retry and retryDelay');
    }

    retry = retry || 0;

    winston.debug('[Pinger] pingRetry: hostname=%s / port=%d / retry=%d / retryDelay=%d', options.hostname, options.port, retry, retryDelay);

    return ping(options)
        .catch((err) => {
            if (retry > 0) {
                return Promise
                    .delay(retryDelay)
                    .then(() => pingRetry(options, retry - 1, retryDelay));
            }

            throw err;
        });
}

function waitPing(options, retryDelay, timeout) {
    if (!options || !options.hostname || !options.port || !retryDelay) {
        throw new Error('[Pinger] waitPing: should have hostname, port and retryDelay');
    }

    winston.debug('[Pinger] waitPing: hostname=%s / port=%d / timeout=%d / retryDelay=%d', options.hostname, options.port, timeout, retryDelay);

    const start = new Date().getTime();

    return pingImpl();


    ////////////

    function pingImpl() {
        winston.debug('[Pinger] waitPing: try %s:%d', options.hostname, options.port);

        return ping(options)
            .catch((err) => {
                const end = new Date().getTime();

                if (timeout &&
                    end - start > timeout) {
                    throw err;
                }

                return Promise
                    .delay(retryDelay)
                    .then(() => pingImpl());
            });
    }
}
