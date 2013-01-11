var obSvc = require('observer-service');
var prefs = require('simple-prefs').prefs;
var url = require('url');
var data = require("self").data;
var tabs = require("tabs");
var xhr = require("xhr");
var timers = require("timers");
var privateBrowsing = require("private-browsing");
var storage = require("simple-storage").storage;
var windowUtils = require("window-utils");
var addontab = require('addon-page');

// APIs not yet exposed through Jetpack libraries:
var {Cc, Ci, Cr} = require('chrome');
var eTLDSvc = Cc["@mozilla.org/network/effective-tld-service;1"].
                getService(Ci.nsIEffectiveTLDService);
var ioService = Cc["@mozilla.org/network/io-service;1"]
                  .getService(Ci.nsIIOService);
var cookieMgr = Cc["@mozilla.org/cookiemanager;1"]
                    .getService(Ci.nsICookieManager2);
var windowMediator = Cc["@mozilla.org/appshell/window-mediator;1"].
               getService(Ci.nsIWindowMediator);

// Global variables:
var deployment = {};
var baseUrls = [];
var baseHosts = {};

// The page to open when user clicks the toolbar icon:
var mainPage = data.url("ui/index.html");
var panelPage = data.url("ui/panel.html");

// The main data structure storing visited sites, trackers, and links between them:
var log = {};
var connections = []; // new 1.0 format

// Array to maintain connections to any pages running collusion UI:
var workers = [];

// Whitelist of domains that user has told us they don't care about tracking them:
var whitelist = [];

var startTime = new Date();
var collusionPanel = null;


function getHistoryForTab(tabIndex) {
    /* Because there doesn't seem to be a Jetpacky way of getting history,
     * I wrote this function that uses XPCOM.
     * Returns an array of strings containing domain names,
     * in chronological order that have been
     * visited in this tab.*/

    var frontWind = windowMediator.getMostRecentWindow("navigator:browser");
    var loadingTab = frontWind.gBrowser.tabContainer.getItemAtIndex(tabIndex);
    // See https://developer.mozilla.org/en-US/docs/Code_snippets/Tabbed_browser
    var sessionHistory = loadingTab.linkedBrowser.sessionHistory;
    // see https://developer.mozilla.org/en-US/docs/XPCOM_Interface_Reference/nsISHistory
    var enumr = sessionHistory.SHistoryEnumerator;

    var yourHistory = [];
    while (enumr.hasMoreElements()) {
        var entry = enumr.getNext().QueryInterface(Ci.nsIHistoryEntry);
        try {
            var host = entry.URI.host;
            yourHistory.push(host);
        } catch (e) {
           // URI.host throws exception for e.g. "about:" urls
        }
    }
    return yourHistory;
}



function attachToCollusionPage(worker) {
  /* Set up channel of communcation between this add-on and the script (index-content-script.js)
   * that we attached to the web page running the Collusion UI. */

  workers.push(worker);
  worker.on("detach", function() {
    workers.splice(workers.indexOf(worker), 1);
  });
  worker.port.on("init", function() {
    worker.port.emit("log", JSON.stringify(log));
	worker.port.emit('initConnections', JSON.stringify(connections));
    worker.port.emit('initSounds', storage.playSounds);
    console.log('initializing sound pref: ', storage.playSounds);
  });
  worker.port.on('setCollusionSounds', function(flag){
      console.log('saving sound pref: ', flag);
      storage.playSounds = flag;
  });
  worker.port.on("reset", function() {
    startTime = new Date();
    log = {};
  });
  worker.port.on("save", function(data) {
    // Don't permanently store data about graph in private browsing mode
    if (!privateBrowsing.isActive) {
		// Version 0
        storage.graph = data;
		// Version 1.0
  		storage.connections = connections;
	}
  });
  worker.port.on("getSavedGraph", function() {
	  // Version 0
      worker.port.emit("getSavedGraph", storage.graph || '{}');
	  // Version 1.0
	  worker.port.emit('getSavedConnections', storage.connections || '[]');
  });
  worker.port.on("import", function(data) {
    var graph = JSON.parse(data);
    // console.log('Graph size: ', Object.keys(graph).length);
    var maxTime = 0;

    for (var domain in graph) {
      var referrers = graph[domain].referrers;
      for (var referrer in referrers) {
          var ref = referrers[referrer];
          if (ref){
              delete ref.upladed; // clean up data
              if (ref.timestamp > maxTime){
                  maxTime = ref.timestamp; // update timestamp
              }
          }else{
              console.log('no referrer named ' + referrer + ' in domain ' + domain);
          }
      }
  }

    startTime = new Date() - maxTime;
    log = graph;
  });

  worker.port.on('importConnections', function(data){
	  connections = JSON.parse(data);
	  console.log('initialized connections on plugin side');
  });

  worker.port.on("whitelistDomain", function(data) {
      whitelistDomain(data.domain);
  });
}


function attachToExistingCollusionPages() {
  for each (var tab in tabs)
    baseUrls.forEach(function(baseUrl) {
      if (tab.url == baseUrl) {
        var worker = tab.attach({
          contentScriptFile: data.url("index-content-script.js")
        });
        attachToCollusionPage(worker);
      }
    });
}


function queueInfo(info) {
  var newSite = false;
  if (!(info.domain in log)) {
    log[info.domain] = { referrers: {},
                         visits: 0 // Will be incremented by tabs.on handler if we visit
                        };
    newSite = true;
  }

  var referrers = log[info.domain].referrers;

  if (!(info.referrer in referrers)) {
    referrers[info.referrer] = {timestamp: (new Date()) - startTime,
				count: 1,
                                datatypes: [],
                                cookie: info.cookie,  // TODO make this an entry in datatypes
                                noncookie: info.noncookie};
    newSite = true;
  } else {
    referrers[info.referrer].count ++; // count of how many times we've seen this connection
  }

  // if (newSite && prefs["collusion.popup"]) {
  //   showCollusionPanel();
  // }

  var types = referrers[info.referrer].datatypes;

  if (types.indexOf(info.type) == -1) {
    // Haven't seen this type before -- either new connection or new datatype - so inform the graph page:
    types.push(info.type);
    workers.forEach(function(worker) {
      worker.port.emit("log", JSON.stringify(log));
    });
  }
}

function getDomain(host) {
  try {
    return eTLDSvc.getBaseDomainFromHost(host);
  } catch (e if e.result == Cr.NS_ERROR_INSUFFICIENT_DOMAIN_LEVELS) {
    return host;
  } catch (e if e.result == Cr.NS_ERROR_HOST_IS_IP_ADDRESS) {
    return host;
  }
}

function whitelistDomain(domain) {
  // console.log("Whitelisting domain " + domain);
  deleteNode(domain);
  whitelist.push(domain); // TODO TEST
  storage.whitelist = JSON.stringify(whitelist);
}

function deleteNode(nodeDomain) {
  for (var domain in log) {
    if (log[domain].referrers[nodeDomain]) {
      // console.log("Removed link to " + domain + " from " + nodeDomain);
      delete log[domain].referrers[nodeDomain];
    }
  }
  if (log[nodeDomain]) {
    delete log[nodeDomain];
    // console.log("Removed all links to " + nodeDomain);
  }

  workers.forEach(function(worker) {
    worker.port.emit("log", JSON.stringify(log));
  });
}

    
// Main entry point. Will be called when Firefox starts or when Collusion is installed:
function initCollusion() {

  try {
    deployment = JSON.parse(data.load("deployment.json"));
  } catch (e) {}

  baseUrls.push(mainPage);
  baseUrls.push(panelPage);
  baseUrls.push(deployment.url || "http://www.mozilla.org/en-US/collusion/");

  prefs['collusion.urls'].split(',').forEach(function(url) {
    url = url.trim();
    if (url.length)
      baseUrls.push(url);
  });

  baseUrls.forEach(function(baseUrl) {
    try {
      baseHosts[url.URL(baseUrl).host] = true;
    } catch (e) {}
  });

  // Attach index-content-script.js to any pages matching one of the baseUrls:
  require("page-mod").PageMod({
    include: baseUrls,
    contentScriptWhen: 'start',
    contentScriptFile: data.url("index-content-script.js"),
    onAttach: attachToCollusionPage
  });

  // Create collusion panel, in case "show graph in panel" pref is turned on.
  collusionPanel = require("panel").Panel({
    width: 510,
    height: 410,
    contentURL: panelPage,
    contentScriptFile: data.url("index-content-script.js")
  });

  // Set up the menu item to open the main UI page:
  var menuitem = require("shared/menuitems").Menuitem({
    id: "collusion_openGraph",
    menuid: "menu_ToolsPopup",
    label: "Collusion Graph",
    onCommand: function() {
      tabs.open({url: mainPage});
    },
    insertbefore: "sanitizeItem",
    image: data.url("favicon.ico")
  });

  // Set up the status bar button to open the main UI page:
  var widget = require("widget").Widget({
    id: "collusion",
    label: "Display Collusion Diagram",
    contentURL: data.url("favicon.ico"),
    onClick: function() {
      tabs.open({url: mainPage});
    }
  });
  // TODO: Don't need both menu item and widget?

  // Load any tracking data that we have stored from last time:
  if (storage.graph) {
	  // version 0
      log = JSON.parse(storage.graph);
  }
  if (storage.connections){
	  // version 1.0
  	  connections = JSON.parse(storage.connections);
  }

  // Load any whitelist we have stored from last time
  if (storage.whitelist) {
    whitelist = JSON.parse(storage.whitelist);
  }


  obSvc.add("cookie-changed", function(topic, data) {
    // https://developer.mozilla.org/en/XPCOM_Interface_Reference/nsICookieService
    if (data == "added") {
      var cookie = topic.QueryInterface(Ci.nsICookie2);
      //console.log("Added cookie for " + cookie.host + " : " + cookie.value);
      var host = "" + cookie.host;
      while (host.charAt(0) == ".") {
        host = host.substr(1);
      }
      var domain = getDomain(host);
      // TODO - we don't know what the referring domain was for this cookie;
      // see https://github.com/mozilla/collusion/issues/86
    }
  });
  
  function isThirdParty(channel){
	  console.log('implement isThirdParty()');
	  return true;
  }
  
  function addConnection(channel, topic, data){
	  // Check to see if this is in fact a third-party connection, if not, return
	  if (!isThirdParty(channel)) return;
	  
	  var source, // domain with subdomain from referrer
	  	  target,  // domain with subdomain of URL loaded
		  timestamp, // 
		  contentType, // 
		  cookie, // boolean
		  sourceVisited, // boolean
		  secure, // boolean
		  sourcePathDepth, // int
		  sourceQueryDepth,  // int
		  sourceTab; // internal-only reference to the tab for visualization and chcking sourceVisited
	  if (!channel.referrer) return;
	  source = channel.referrer.host;
	  target = channel.URI.host;
	  timestamp = Date.now();
	  contentType = channel.contentType || 'text/plain';
	  try{
		  cookie = !!channel.getRequestHeader('Cookie');
	  }catch(e){
	  	  cookie = false;
	  }
	  var protocol = channel.URI.scheme;
	  switch(protocol){
		  case 'http': secure = false; break;
		  case 'https': secure = true; break;
		  default: secure = false; console.log('unsupported protocol: %s', protocol); return;
	  }
	  sourcePathDepth = channel.URI.path.split('/').length - 1;
	  if (channel.URI.query){
		  sourceQueryDepth = channel.URI.query.split(/;|\&/).length;
	  }else{
	  	  sourceQueryDepth = 0;
	  }
	  sourceTab = getTabFromChannel(channel); // this is where the fun begins!
	  
  }
  function getTabFromChannel(channel) {
	  // Source: http://stackoverflow.com/questions/8098580/identify-tab-that-made-request-in-firefox-addon-sdk
      try {
          var noteCB= channel.notificationCallbacks ? channel.notificationCallbacks : channel.loadGroup.notificationCallbacks;

          if (!noteCB) { return null; }
		  try{
			  var domWin = noteCB.getInterface(Ci.nsIDOMWindow);
		  }catch(e){
			  return '[tab]';
		  }
          return domWin.top;
      } catch (e) {
          dump(e + "\n");
          return null;
      }
  }


  // Set up an observer to record third-party http requests. This callback
  // right here is the crux of Collusion!
  obSvc.add("http-on-examine-response", function(subject, topic, data) {
    var channel = subject.QueryInterface(Ci.nsIHttpChannel),
        type = null,
        cookie = null;

      //See https://developer.mozilla.org/en-US/docs/XPCOM_Interface_Reference/nsIHttpChannel
	  
	  // 1.0 handler
	  addConnection(channel, topic, data);

    if (channel.referrer) {
      var referrerDomain = getDomain(channel.referrer.host);
      var domain = getDomain(channel.URI.host);

      // This is a fix for https://github.com/mozilla/collusion/issues/7.
      if (channel.referrer.host in baseHosts)
        return;

      // Ignore cookies from whitelisted sites. TODO: Or is that cookies TO whitelisted sites?
      if (channel.referrer.host in whitelist)
        return;

      if (domain != referrerDomain) {
        // There is a connection between two different sites!
        var connection = {
              domain: domain,
              referrer: referrerDomain
        };

        // What is the datatype of the third-party request?
        try {
          type = subject.getResponseHeader("Content-Type");
        } catch (e if e.result == Cr.NS_ERROR_NOT_AVAILABLE) {}
        connection.type = type;

        // Does it contain a cookie?
        try {
          cookie = subject.getRequestHeader("Cookie");
        } catch (e if e.result == Cr.NS_ERROR_NOT_AVAILABLE) {}

        if (!cookie) {
          try {
            cookie = subject.getResponseHeader("Set-Cookie");
          } catch (e if e.result == Cr.NS_ERROR_NOT_AVAILABLE) {}
        }

        if (cookie) {
          connection.cookie = true;
            // Play sound when cookie set (if CollusionSound pref is true)
            var strPref = prefs.CollusionSound;
            if (strPref) {
              var ios = Cc['@mozilla.org/network/io-service;1'].getService(Ci.nsIIOService);
              var soundURL = require("self").data.url("CameraSound.wav");
              var soundTwo = ios.newURI(soundURL, null, null);
              var player = Cc["@mozilla.org/sound;1"].createInstance(Ci.nsISound);
              player.play(soundTwo);
            }
          }
        else {
          /* TODO in the future we will flag other types, but for now just mark the ones that
           * aren't cookies "noncookie". */
          connection.noncookie = true;
          // TODO this is technically wrong - here noncookie means "not cookie" whereas later
          // cookie and noncookie are orthogonal.
        }
        // Record it!
        queueInfo(connection);
      }
    }
  });

  // Site Blocking Implementation:
  obSvc.add("http-on-modify-request", function(subject, topic, data) {
    var channel = subject.QueryInterface(Ci.nsIHttpChannel);
    var domain = getDomain(channel.URI.host);
  });

  // Clear graph when going into private browsing mode:
  privateBrowsing.on("start", function() {
    log = {};
  });

  // Restore original graph when leaving private browsing mode:
  privateBrowsing.on("stop", function() {
    if (storage.graph) {
		// version 0
        log = JSON.parse(storage.graph);
    }
	if (storage.connections){
		// version 1.0
		connections = JSON.parse(storage.connections);
	}
  });

  // When a site loads in a tab, make a record that the domain is one actively
  // visited by the user:
  tabs.on("ready", function(tab) {
    // skip "about:" urls
    if (tab.url.indexOf("about:") == 0) {
      return;
    }
    var domain = getDomain(ioService.newURI(tab.url, null, null).host);
    if (!(domain in log)) {
      log[domain] = { referrers: {},
                      visits: 1 };
    }
    log[domain].visits ++;

    /* Look at history of pages visited in this tab - specifically the last
     * two domains. Because they are successive in history, you got from one
     * to the other via a navigation event. So add "navigation" to the list
     * of data types for the link. */
      var history = getHistoryForTab(tab.index);
      if (history.length >= 2) {
        var previousDomain = getDomain( history[ history.length - 2 ] );
        if (domain != previousDomain) {
          queueInfo({domain: domain,
                     referrer: previousDomain,
                     type: "user_navigation"});
        }
      }
  });

  // If any collusion UI pages are already open when we start, connect to them:
  attachToExistingCollusionPages();

  // Init reset timer
  if (prefs["collusion.reset.timer"] > 0) {
    timers.setInterval(function() {
      startTime = new Date();
      log = {};
    }, prefs["collusion.reset.timer"]);
  }
}


// Start!
initCollusion();

