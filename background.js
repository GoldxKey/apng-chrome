var isPNG = function (info) {
    for (var i = 0, l = info.responseHeaders.length; i < l; i++) {
        var h = info.responseHeaders[i];
        if (h.name.toLowerCase() == "content-type") {
            return (h.value.toLowerCase() == "image/png");
        }
    }
    return false;
};
var isVolatile = function (info) {
    if (info.fromCache) return false;
    if (info.method != "GET") return true;
    for (var i = 0, l = info.responseHeaders.length; i < l; i++) {
        var n = info.responseHeaders[i].name.toLowerCase();
        var v = info.responseHeaders[i].value.toLowerCase();
        if (
                n == "cache-control" && (
                        v.indexOf("no-cache") != -1
                                || v.indexOf("no-store") != -1
                                || v.indexOf("must-revalidate") != -1
                        )
                        || n == "pragma" && v.indexOf("no-cache") != -1
                        || n == "expires" && new Date(v) <= new Date()
                ) {
            return true;
        }
    }
    return false;
};


var checkHostname = function (hostname) {
    var mode = localStorage["mode"];
    if (mode != "white") mode = "black";
    var list = localStorage[mode + "List"];
    var hostNames = list ? list.toLowerCase().split(/[^a-z0-9.-]+/) : [];
    var inList = (hostNames.indexOf(hostname.toLowerCase()) !== -1);
    return (mode == "black") ? !inList : inList;
};

var PNGUrls = {};
var redirects = {};

// GC
var lastPNGFound = new Date();
(function() {
    if (new Date - lastPNGFound > 10*60*1000) {
        // если больше 10 минут не было новых картинок
        chrome.webRequest.handlerBehaviorChanged();
        lastPNGFound = new Date();
        PNGUrls = {};
        redirects = {};
        // возвращаемся через час
        setTimeout(arguments.callee, 60*60*1000);
    } else {
        // возвращаемся через 10 минут
        setTimeout(arguments.callee, 10*60*1000);
    }
})();

chrome.webRequest.onCompleted.addListener(
        function (info) {
            if (!(info.url in PNGUrls)) {
                PNGUrls[info.url] = Deferred();
                lastPNGFound = new Date();
            }
            if (!PNGUrls[info.url].promise().isResolved()) {
                PNGUrls[info.url].resolve(isPNG(info) && !isVolatile(info));
            }
        },
        { urls:["<all_urls>"], types:["image", "main_frame", "sub_frame"] },
        ["responseHeaders"]
);

chrome.webRequest.onBeforeRedirect.addListener(
    function (info) { redirects[info.url] = info.redirectUrl; },
    { urls:["<all_urls>"], types:["image", "main_frame", "sub_frame"] }
);

var deepCheckUrl = function(url, d) {
    if (url in redirects) {
        deepCheckUrl(redirects[url], d);
    } else if (!(url in PNGUrls)) {
        PNGUrls[url] = Deferred();
    }
    PNGUrls[url].promise().done(function(result) { d.resolve(result); });
};

chrome.extension.onRequest.addListener(function(request, sender, callback) {
    if (request.action == "checkUrl") {
        var d = Deferred();
        d.promise().done(callback);
        deepCheckUrl(request.url, d);
    } else if (request.action == "isAnAPNG") {
        if (!(request.url in PNGUrls)) {
            PNGUrls[request.url] = Deferred();
        }
        PNGUrls[request.url].resolve(request.isIt);
    } else if (request.action == "checkHostname") {
        var enabled = checkHostname(request.data);
        chrome.browserAction.setIcon({
            "tabId":sender.tab.id,
            "path": enabled ? "img/apng-logo-19-on.png" : "img/apng-logo-19-off.png"
        });
        callback(enabled);
    } else if (request.action == "apngFound" && request.data > 0) {
        chrome.browserAction.setIcon({
            "tabId":sender.tab.id,
            "path":"img/apng-logo-19-found.png"
        });
        chrome.browserAction.setBadgeText({
            "tabId":sender.tab.id,
            "text":request.data.toString()
        });
    }
});
