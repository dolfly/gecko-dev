let Cm = Components.manager;

let swm = Cc["@mozilla.org/serviceworkers/manager;1"].getService(
  Ci.nsIServiceWorkerManager
);

const URI =
  "https://example.com/browser/dom/notification/test/browser/empty.html";
const MOCK_CID = Components.ID("{2a0f83c4-8818-4914-a184-f1172b4eaaa7}");
const SYSTEM_CID = Components.ID("{a0ccaaf8-09da-44d8-b250-9ac3e93c8117}");
const ALERTS_SERVICE_CONTRACT_ID = "@mozilla.org/alerts-service;1";
const USER_CONTEXT_ID = 3;

let mockAlertsService = {
  showAlert(alert, alertListener) {
    ok(true, "Showing alert");
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    setTimeout(function () {
      alertListener.observe(null, "alertshow", alert.cookie);
    }, 100);
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    setTimeout(function () {
      alertListener.observe(null, "alertclickcallback", alert.cookie);
    }, 100);
  },

  QueryInterface: ChromeUtils.generateQI(["nsIAlertsService"]),

  createInstance(aIID) {
    return this.QueryInterface(aIID);
  },
};

registerCleanupFunction(() => {
  const registrar = Cm.QueryInterface(Ci.nsIComponentRegistrar);
  registrar.unregisterFactory(MOCK_CID, mockAlertsService);
  registrar.registerFactory(SYSTEM_CID, "", ALERTS_SERVICE_CONTRACT_ID, null);
});

add_setup(async function () {
  // make sure userContext, SW and notifications are enabled.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["privacy.userContext.enabled", true],
      ["dom.serviceWorkers.exemptFromPerDomainMax", true],
      ["dom.serviceWorkers.enabled", true],
      ["dom.serviceWorkers.testing.enabled", true],
      ["dom.webnotifications.disable_open_click_delay", 1000],
      ["dom.serviceWorkers.idle_timeout", 299999],
      ["dom.serviceWorkers.idle_extended_timeout", 299999],
      ["browser.link.open_newwindow", 3],
    ],
  });
});

add_task(async function test() {
  Cm.QueryInterface(Ci.nsIComponentRegistrar).registerFactory(
    MOCK_CID,
    "alerts service",
    ALERTS_SERVICE_CONTRACT_ID,
    mockAlertsService
  );

  // open the tab in the correct userContextId
  let tab = BrowserTestUtils.addTab(gBrowser, URI, {
    userContextId: USER_CONTEXT_ID,
  });
  let browser = gBrowser.getBrowserForTab(tab);

  // select tab and make sure its browser is focused
  gBrowser.selectedTab = tab;
  tab.ownerGlobal.focus();

  // wait for tab load
  await BrowserTestUtils.browserLoaded(gBrowser.getBrowserForTab(tab));

  // Waiting for new tab.
  let newTabPromise = BrowserTestUtils.waitForNewTab(gBrowser, null, true);

  // here the test.
  /* eslint-disable no-shadow */
  let uci = await SpecialPowers.spawn(browser, [], async () => {
    let uci = content.document.nodePrincipal.userContextId;

    await SpecialPowers.pushPermissions([
      {
        type: "desktop-notification",
        allow: SpecialPowers.Services.perms.ALLOW_ACTION,
        context: content.document,
      },
    ]);

    // Registration of the SW
    const swr = await content.navigator.serviceWorker.register(
      "file_userContextId_openWindow.serviceworker.js"
    );

    // Activation
    await new content.window.Promise(resolve => {
      let worker = swr.installing;
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") {
          resolve(swr);
        }
      });
    });

    // Ask for an openWindow.
    await swr.showNotification("testPopup");
    return uci;
  });
  /* eslint-enable no-shadow */

  is(uci, USER_CONTEXT_ID, "Tab runs with UCI " + USER_CONTEXT_ID);

  let newTab = await newTabPromise;

  is(
    newTab.getAttribute("usercontextid"),
    USER_CONTEXT_ID.toString(),
    "New tab has UCI equal " + USER_CONTEXT_ID
  );

  // wait for SW unregistration
  /* eslint-disable no-shadow */
  uci = await SpecialPowers.spawn(browser, [], () => {
    let uci = content.document.nodePrincipal.userContextId;

    return content.navigator.serviceWorker
      .getRegistration(".")
      .then(registration => {
        return registration.unregister();
      })
      .then(() => {
        return uci;
      });
  });
  /* eslint-enable no-shadow */

  is(uci, USER_CONTEXT_ID, "Tab runs with UCI " + USER_CONTEXT_ID);

  BrowserTestUtils.removeTab(newTab);
  BrowserTestUtils.removeTab(tab);
});
