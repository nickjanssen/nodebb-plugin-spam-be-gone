var	Akismet = require('akismet'),
    Honeypot = require('project-honeypot'),
    simpleRecaptcha = require('simple-recaptcha'),
    pluginData = require('./plugin.json'),
    winston = module.parent.require('winston'),
    nconf = module.parent.require('nconf'),
    async = module.parent.require('async'),
    Meta = module.parent.require('./meta'),
    akismet, honeypot, recaptchaArgs, pluginSettings,
    Plugin = {};

pluginData.nbbId = pluginData.id.replace(/nodebb-plugin-/, '');

var util = {
    keys: function(obj, props, value) {
        if(props == null || obj == null)
            return undefined;

        var i = props.indexOf(".");
        if( i == -1 ) {
            if(value !== undefined)
                obj[props] = value;
            return obj[props];
        }
        var prop = props.slice(0, i),
            newProps = props.slice(i + 1);

        if(props !== undefined && !(obj[prop] instanceof Object) )
            obj[prop] = {};

        return util.keys(obj[prop], newProps, value);
    }
};

Plugin.load = function(app, middleware, controllers, callback) {

    var render = function(req, res, next) {
        res.render('admin/plugins/' + pluginData.nbbId, pluginData || {});
    };

    Meta.settings.get(pluginData.nbbId, function(err, settings) {
        if (!err && settings) {
            if (settings.akismetEnabled === 'on') {
                if (settings.akismetApiKey) {
                    akismet = require('akismet').client({blog: nconf.get('base_url'), apiKey: settings.akismetApiKey});
                    akismet.verifyKey(function(err, verified) {
                        if (!verified) {
                            winston.error('[plugins/' + pluginData.nbbId + '] Unable to verify Akismet API key.');
                            akismet = null;
                        }
                    });
                } else {
                    winston.error('[plugins/' + pluginData.nbbId + '] Akismet API Key not set!');
                }
            }

            if (settings.honeypotEnabled === 'on') {
                if (settings.honeypotApiKey) {
                    honeypot = Honeypot(settings.honeypotApiKey)
                } else {
                    winston.error('[plugins/' + pluginData.nbbId + '] Honeypot API Key not set!');
                }
            }

            if (settings.recaptchaEnabled === 'on') {
                if (settings.recaptchaPublicKey && settings.recaptchaPrivateKey ) {
                    var recaptchaLanguages = {'en': 1, 'nl': 1, 'fr': 1, 'de': 1, 'pt': 1, 'ru': 1, 'es': 1, 'tr': 1},
                        lang = (Meta.config.defaultLang || 'en').toLowerCase();

                    recaptchaArgs = {
                        publicKey: settings.recaptchaPublicKey,
                        targetId: pluginData.nbbId + '-recaptcha-target',
                        options: {
                            // theme: settings.recaptchaTheme || 'clean',
                            //todo: switch to custom theme, issue#9
                            theme: 'clean',
                            lang: recaptchaLanguages[lang] ? lang : 'en',
                            tabindex: settings.recaptchaTabindex || 0
                        }
                    };
                }
            } else {
                recaptchaArgs = null;
            }
            winston.info('[plugins/' + pluginData.nbbId + '] Settings loaded');
            pluginSettings = settings;
        } else {
            winston.warn('[plugins/' + pluginData.nbbId + '] Settings not set or could not be retrived!');
        }

        app.get('/admin/plugins/' + pluginData.nbbId, middleware.admin.buildHeader, render);
        app.get('/api/admin/plugins/' + pluginData.nbbId, render);

        if (typeof callback === 'function') {
            callback();
        }
    });
};

Plugin.addCaptcha = function(req, res, templateData, callback) {
    if (recaptchaArgs) {
        var captcha = {
            label: 'Captcha',
            html: ''
                + '<div id="' + pluginData.nbbId + '-recaptcha-target"></div>'
                + '<script id="' + pluginData.nbbId + '-recaptcha-script">\n\n'
                +	'window.plugin = window.plugin || {};\n\t\t\t'
                +   'plugin["' + pluginData.nbbId + '"] = window.plugin["' + pluginData.nbbId + '"] || {};\n\t\t\t'
                + 	'plugin["' + pluginData.nbbId + '"].recaptchaArgs = ' + JSON.stringify(recaptchaArgs) + ';\n'
                + '</script>',
            styleName: pluginData.nbbId
        };
        if (templateData.regFormEntry && Array.isArray(templateData.regFormEntry)) {
            templateData.regFormEntry.push(captcha);
        } else {
            templateData.captcha = captcha;
        }
    }
    callback(null, req, res, templateData);
};

Plugin.checkReply = function(data, callback) {
    // http://akismet.com/development/api/#comment-check
    if (akismet && data.req) {
        akismet.checkSpam({
            user_ip: data.req.ip,
            user_agent: data.req.headers['user-agent'],
            blog: data.req.protocol + '://' + data.req.host,
            permalink: data.req.path,
            comment_content: data.content,
            comment_author: data.username
        }, function(err, spam) {
            if (err) {
                winston.error(err);
            }
            if(spam)  {
                winston.warn('[plugins/' + pluginData.nbbId + '] Post "' + data.content + '" by uid: ' + data.username + '@' + data.req.ip + ' was flagged as spam and rejected.');
                callback(new Error('Post content was flagged as spam by Akismet.com'), data);
            } else {
                callback(null, data);
            }
        });
    } else {
        callback(null, data);
    }
};

Plugin.checkRegister = function(req, res, userData, callback) {
    async.parallel([
        function(next) {
            Plugin._honeypotCheck(req, res, userData, next);
        },
        function(next) {
            Plugin._recaptchaCheck(req, res, userData, next)
        }
    ], function(err, results) {
        callback(err, req, res, userData);
    });
};

Plugin._honeypotCheck = function(req, res, userData, next) {
    if (honeypot && req && req.ip) {
        honeypot.query(req.ip, function (err, results) {
            if (err) {
                winston.error(err);
                next(null, userData);
            } else {
                if (results && results.found && results.type) {
                    if (results.type.spammer || results.type.suspicious) {
                        var message = userData.username + ' | ' + userData.email + ' was detected as ' +  (results.type.spammer ? 'spammer' : 'suspicious');

                        winston.warn('[plugins/' + pluginData.nbbId + '] ' + message + ' and was denied registration.');
                        next({source: 'honeypot', message: message}, userData);
                    } else {
                        next(null, userData);
                    }
                } else {
                    winston.warn('[plugins/' + pluginData.nbbId + '] username:' + userData.username + ' ip:' + req.ip + ' was not found in Honeypot database');
                    next(null, userData);
                }
            }
        });
    } else {
        next(null, userData);
    }
};

Plugin._recaptchaCheck = function(req, res, userData, next) {
    if (recaptchaArgs && req && req.ip && req.body) {

        simpleRecaptcha(
            pluginSettings.recaptchaPrivateKey,
            req.ip,
            req.body.recaptcha_challenge_field,
            req.body.recaptcha_response_field,
            function(err) {
                if (err) {
                    var message = err.Error || 'Wrong Captcha';
                    winston.warn('[plugins/' + pluginData.nbbId + '] ' + message);
                    next({source: 'recaptcha', message: message}, userData);
                } else {
                    next(null, userData);
                }
            }
        );
    } else {
        next(null, userData);
    }
};

Plugin.admin = {
    menu: function(custom_header, callback) {
        custom_header.plugins.push({
            "route": '/plugins/' + pluginData.nbbId,
            "icon": pluginData.faIcon,
            "name": pluginData.name
        });

        callback(null, custom_header);
    }
};

module.exports = Plugin;
