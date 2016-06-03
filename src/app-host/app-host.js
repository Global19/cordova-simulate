// Copyright (c) Microsoft Corporation. All rights reserved.

var livereload = require('./live-reload-client');
var Messages = require('messages');
var telemetry = require('telemetry-helper');

var cordova;
var socket = io();
var nextExecCacheIndex = 0;
var execCache = {};
var pluginHandlers = {};
var serviceToPluginMap = {};

function clobber(clobbers, scope, clobberToPluginMap, pluginId) {
    Object.keys(clobbers).forEach(function (key) {
        if (clobberToPluginMap && pluginId) {
            clobberToPluginMap[key] = pluginId;
        }

        if (clobbers[key] && typeof clobbers[key] === 'object') {
            scope[key] = scope[key] || {};
            clobber(clobbers[key], scope[key]);
        } else {
            scope[key] = clobbers[key];
        }
    });
}

// Details of each plugin that has app-host code is injected when this file is served.
var plugins = {
    /** PLUGINS **/
};

var pluginHandlersDefinitions = {
    /** PLUGIN-HANDLERS **/
};

var pluginClobberDefinitions = {
    /** PLUGIN-CLOBBERS **/
};

var pluginMessages = {};

function applyPlugins(plugins, clobberScope, clobberToPluginMap) {
    Object.keys(plugins).forEach(function (pluginId) {
        var plugin = plugins[pluginId];
        if (plugin) {
            if (typeof plugin === 'function') {
                pluginMessages[pluginId] = pluginMessages[pluginId] || new Messages(pluginId, socket);
                plugin = plugin(pluginMessages[pluginId], exec);
                plugins[pluginId] = plugin;
            }
            if (clobberScope) {
                clobber(plugin, clobberScope, clobberToPluginMap, pluginId);
            }
        }
    });
}

function setCordova(originalCordova) {
    var channel,
        platform,
        platformBoostrap;

    if (cordova) {
        return;
    }

    cordova = originalCordova;

    cordova.define.remove('cordova/exec');
    cordova.define('cordova/exec', function (require, exports, module) {
        module.exports = exec;
    });

    platform = cordova.require('cordova/platform');
    platformBootstrap = platform.bootstrap;
    platform.bootstrap = function () {
    };

    // default Windows bootstrap function tries to load WinJS which is not
    // available and not required in simulation mode so we override bootstrap
    if (cordova.platformId === 'windows') {
        platformBootstrap = function () {
            cordova.require('cordova/modulemapper')
                .clobbers('cordova/exec/proxy', 'cordova.commandProxy');

        };
    }

    channel = cordova.require('cordova/channel');

    // define our own channel to delay the initialization until sim-host tells
    // us everything's ready (fired in 'start' event handler).
    channel.createSticky('onCordovaSimulateReady');
    channel.waitForInitialization('onCordovaSimulateReady');

    // firing of onNativeReady is delayed until SIM_HOST tells us it's ready
    socket.once('init', function () {
        // sim-host is ready, register exec handlers, fire onNativeReady and send
        // the list of plugins
        socket.on('exec-success', function (data) {
            console.log('exec-success:');
            console.log(data);
            var execCacheInfo = execCache[data.index];
            if (execCacheInfo.success) {
                execCacheInfo.success(data.result);
            }
        });

        socket.on('exec-failure', function (data) {
            console.log('exec-failure:');
            console.log(data);
            var execCacheInfo = execCache[data.index];
            if (execCacheInfo.fail) {
                execCacheInfo.fail(data.error);
            }
        });

        socket.on('start-live-reload', function () {
            livereload.start(socket);
        });

        socket.on('init-telemetry', function (data) {
            telemetry.init(socket);
        });

        socket.on('init-xhr-proxy', function (data) {
            require('xhr-proxy').init(); 
        });

        socket.on('init-touch-events', function (data) {
            require('./touch-events').init();
        });

        if (cordova.platformId !== 'browser') {
            channel.onPluginsReady.subscribe(function () {
                var pluginList = cordova.require('cordova/plugin_list').metadata;
                socket.emit('app-plugin-list', pluginList);
            });
        } else {
            socket.emit('app-plugin-list', {});
        }

        applyPlugins(plugins);
        applyPlugins(pluginHandlersDefinitions, pluginHandlers, serviceToPluginMap);
        applyPlugins(pluginClobberDefinitions, window);

        platformBootstrap();

        switch (cordova.platformId) {
            // these platform fire onNativeReady in their bootstrap
            case 'ios':
            case 'browser':
            case 'blackberry10':
            case 'firefoxos':
            case 'ubuntu':
            case 'webos':
                break;
            // windows has an overriden bootstrap which does not fire
            // onNativeReady
            case 'windows':
            default:
                channel.onNativeReady.fire();
                break;
        }

    });

    socket.once('start', function () {
        // all set, fire onCordovaSimulate ready (which up to this point was
        // delaying onDeviceReady).
        channel.onCordovaSimulateReady.fire();
        // an init after start means reload. it is only sent if sim-host was
        // reloaded
        socket.once('init', function () {
            window.location.reload();
        });
    });

    // register app-host
    socket.emit('register-app-host');

}

function getCordova() {
    return cordova;
}

function exec(success, fail, service, action, args) {
    // If we have a local handler, call that. Otherwise pass it to the simulation host.
    var handler = pluginHandlers[service] && pluginHandlers[service][action];
    if (handler) {
        telemetry.sendClientTelemetry('exec', { handled: 'app-host', plugin: serviceToPluginMap[service], service: service, action: action });

        // Ensure local handlers are executed asynchronously.
        setTimeout(function () {
            handler(success, fail, service, action, args);
        }, 0);
    } else {
        var execIndex = nextExecCacheIndex++;
        execCache[execIndex] = { index: execIndex, success: success, fail: fail };
        socket.emit('exec', { index: execIndex, service: service, action: action, args: args, hasSuccess: !!success, hasFail: !!fail });
    }
}

// have this stub function always, some platforms require it
exec.init = function () {
};

// Setup for cordova patching
Object.defineProperty(window, 'cordova', {
    set: setCordova,
    get: getCordova
});

