/* -*- js-indent-level: 2; indent-tabs-mode: nil -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = ["TelemetryStorage"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Log.jsm");
Cu.import("resource://gre/modules/Services.jsm", this);
Cu.import("resource://gre/modules/XPCOMUtils.jsm", this);
Cu.import("resource://gre/modules/osfile.jsm", this);
Cu.import("resource://gre/modules/Task.jsm", this);
Cu.import("resource://gre/modules/TelemetryUtils.jsm", this);
Cu.import("resource://gre/modules/Promise.jsm", this);

XPCOMUtils.defineLazyModuleGetter(this, 'Deprecated',
  'resource://gre/modules/Deprecated.jsm');

const LOGGER_NAME = "Toolkit.Telemetry";
const LOGGER_PREFIX = "TelemetryStorage::";

const Telemetry = Services.telemetry;

// Compute the path of the pings archive on the first use.
const DATAREPORTING_DIR = "datareporting";
const PINGS_ARCHIVE_DIR = "archived";
const ABORTED_SESSION_FILE_NAME = "aborted-session-ping";
XPCOMUtils.defineLazyGetter(this, "gDataReportingDir", function() {
  return OS.Path.join(OS.Constants.Path.profileDir, DATAREPORTING_DIR);
});
XPCOMUtils.defineLazyGetter(this, "gPingsArchivePath", function() {
  return OS.Path.join(gDataReportingDir, PINGS_ARCHIVE_DIR);
});
XPCOMUtils.defineLazyGetter(this, "gAbortedSessionFilePath", function() {
  return OS.Path.join(gDataReportingDir, ABORTED_SESSION_FILE_NAME);
});

// Files that have been lying around for longer than MAX_PING_FILE_AGE are
// deleted without being loaded.
const MAX_PING_FILE_AGE = 14 * 24 * 60 * 60 * 1000; // 2 weeks

// Files that are older than OVERDUE_PING_FILE_AGE, but younger than
// MAX_PING_FILE_AGE indicate that we need to send all of our pings ASAP.
const OVERDUE_PING_FILE_AGE = 7 * 24 * 60 * 60 * 1000; // 1 week

// Maximum number of pings to save.
const MAX_LRU_PINGS = 50;

// Maxmimum time, in milliseconds, archive pings should be retained.
const MAX_ARCHIVED_PINGS_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;  // 180 days

// The number of outstanding saved pings that we have issued loading
// requests for.
let pingsLoaded = 0;

// The number of pings that we have destroyed due to being older
// than MAX_PING_FILE_AGE.
let pingsDiscarded = 0;

// The number of pings that are older than OVERDUE_PING_FILE_AGE
// but younger than MAX_PING_FILE_AGE.
let pingsOverdue = 0;

// Data that has neither been saved nor sent by ping
let pendingPings = [];

let isPingDirectoryCreated = false;

/**
 * This is a policy object used to override behavior for testing.
 */
let Policy = {
  now: () => new Date(),
};

this.TelemetryStorage = {
  get MAX_PING_FILE_AGE() {
    return MAX_PING_FILE_AGE;
  },

  get OVERDUE_PING_FILE_AGE() {
    return OVERDUE_PING_FILE_AGE;
  },

  get MAX_LRU_PINGS() {
    return MAX_LRU_PINGS;
  },

  get pingDirectoryPath() {
    return OS.Path.join(OS.Constants.Path.profileDir, "saved-telemetry-pings");
  },

  /**
   * Shutdown & block on any outstanding async activity in this module.
   *
   * @return {Promise} Promise that is resolved when shutdown is complete.
   */
  shutdown: function() {
    return TelemetryStorageImpl.shutdown();
  },

  /**
   * Save an archived ping to disk.
   *
   * @param {object} ping The ping data to archive.
   * @return {promise} Promise that is resolved when the ping is successfully archived.
   */
  saveArchivedPing: function(ping) {
    return TelemetryStorageImpl.saveArchivedPing(ping);
  },

  /**
   * Load an archived ping from disk.
   *
   * @param {string} id The pings id.
   * @return {promise<object>} Promise that is resolved with the ping data.
   */
  loadArchivedPing: function(id) {
    return TelemetryStorageImpl.loadArchivedPing(id);
  },

  /**
   * Clean the pings archive by removing old pings.
   * This will scan the archive directory.
   *
   * @return {Promise} Resolved when the cleanup task completes.
   */
  runCleanPingArchiveTask: function() {
    return TelemetryStorageImpl.runCleanPingArchiveTask();
  },

  /**
   * Reset the storage state in tests.
   */
  reset: function() {
    return TelemetryStorageImpl.reset();
  },

  /**
   * Test method that allows waiting on the archive clean task to finish.
   */
  testCleanupTaskPromise: function() {
    return (TelemetryStorageImpl._archiveCleanTask || Promise.resolve());
  },

  /**
   * Get a list of info on the archived pings.
   * This will scan the archive directory and grab basic data about the existing
   * pings out of their filename.
   *
   * @return {promise<sequence<object>>}
   */
  loadArchivedPingList: function() {
    return TelemetryStorageImpl.loadArchivedPingList();
  },

  /**
   * Save an aborted-session ping to disk. This goes to a special location so
   * it is not picked up as a pending ping.
   *
   * @param {object} ping The ping data to save.
   * @return {promise} Promise that is resolved when the ping is successfully saved.
   */
  saveAbortedSessionPing: function(ping) {
    return TelemetryStorageImpl.saveAbortedSessionPing(ping);
  },

  /**
   * Load the aborted-session ping from disk if present.
   *
   * @return {promise<object>} Promise that is resolved with the ping data if found.
   *                           Otherwise returns null.
   */
  loadAbortedSessionPing: function() {
    return TelemetryStorageImpl.loadAbortedSessionPing();
  },

  /**
   * Remove the aborted-session ping if present.
   *
   * @return {promise} Promise that is resolved once the ping is removed.
   */
  removeAbortedSessionPing: function() {
    return TelemetryStorageImpl.removeAbortedSessionPing();
  },

  /**
   * Save a single ping to a file.
   *
   * @param {object} ping The content of the ping to save.
   * @param {string} file The destination file.
   * @param {bool} overwrite If |true|, the file will be overwritten if it exists,
   * if |false| the file will not be overwritten and no error will be reported if
   * the file exists.
   * @returns {promise}
   */
  savePingToFile: function(ping, file, overwrite) {
    return TelemetryStorageImpl.savePingToFile(ping, file, overwrite);
  },

  /**
   * Save a ping to its file.
   *
   * @param {object} ping The content of the ping to save.
   * @param {bool} overwrite If |true|, the file will be overwritten
   * if it exists.
   * @returns {promise}
   */
  savePing: function(ping, overwrite) {
    return TelemetryStorageImpl.savePing(ping, overwrite);
  },

  /**
   * Save all pending pings.
   *
   * @param {object} sessionPing The additional session ping.
   * @returns {promise}
   */
  savePendingPings: function(sessionPing) {
    return TelemetryStorageImpl.savePendingPings(sessionPing);
  },

  /**
   * Add a ping to the saved pings directory so that it gets saved
   * and sent along with other pings.
   *
   * @param {Object} pingData The ping object.
   * @return {Promise} A promise resolved when the ping is saved to the pings directory.
   */
  addPendingPing: function(pingData) {
    return TelemetryStorageImpl.addPendingPing(pingData);
  },

  /**
   * Add a ping from an existing file to the saved pings directory so that it gets saved
   * and sent along with other pings.
   * Note: that the original ping file will not be modified.
   *
   * @param {String} pingPath The path to the ping file that needs to be added to the
   *                           saved pings directory.
   * @return {Promise} A promise resolved when the ping is saved to the pings directory.
   */
  addPendingPingFromFile: function(pingPath) {
    return TelemetryStorageImpl.addPendingPingFromFile(pingPath);
  },

  /**
   * Remove the file for a ping
   *
   * @param {object} ping The ping.
   * @returns {promise}
   */
  cleanupPingFile: function(ping) {
    return TelemetryStorageImpl.cleanupPingFile(ping);
  },

  /**
   * Load all saved pings.
   *
   * Once loaded, the saved pings can be accessed (destructively only)
   * through |popPendingPings|.
   *
   * @returns {promise}
   */
  loadSavedPings: function() {
    return TelemetryStorageImpl.loadSavedPings();
  },

  /**
   * Load the histograms from a file.
   *
   * Once loaded, the saved pings can be accessed (destructively only)
   * through |popPendingPings|.
   *
   * @param {string} file The file to load.
   * @returns {promise}
   */
  loadHistograms: function loadHistograms(file) {
    return TelemetryStorageImpl.loadHistograms(file);
  },

  /**
   * The number of pings loaded since the beginning of time.
   */
  get pingsLoaded() {
    return TelemetryStorageImpl.pingsLoaded;
  },

  /**
   * The number of pings loaded that are older than OVERDUE_PING_FILE_AGE
   * but younger than MAX_PING_FILE_AGE.
   */
  get pingsOverdue() {
    return TelemetryStorageImpl.pingsOverdue;
  },

  /**
   * The number of pings that we just tossed out for being older than
   * MAX_PING_FILE_AGE.
   */
  get pingsDiscarded() {
    return TelemetryStorageImpl.pingsDiscarded;
  },

  /**
   * Iterate destructively through the pending pings.
   *
   * @return {iterator}
   */
  popPendingPings: function*() {
    while (pendingPings.length > 0) {
      let data = pendingPings.pop();
      yield data;
    }
  },

  testLoadHistograms: function(file) {
    return TelemetryStorageImpl.testLoadHistograms(file);
  },

  /**
   * Loads a ping file.
   * @param {String} aFilePath The path of the ping file.
   * @return {Promise<Object>} A promise resolved with the ping content or rejected if the
   *                           ping contains invalid data.
   */
  loadPingFile: Task.async(function* (aFilePath) {
    return TelemetryStorageImpl.loadPingFile(aFilePath);
  }),
};

/**
 * This object allows the serialisation of asynchronous tasks. This is particularly
 * useful to serialise write access to the disk in order to prevent race conditions
 * to corrupt the data being written.
 * We are using this to synchronize saving to the file that TelemetrySession persists
 * its state in.
 */
function SaveSerializer() {
  this._queuedOperations = [];
  this._queuedInProgress = false;
  this._log = Log.repository.getLoggerWithMessagePrefix(LOGGER_NAME, LOGGER_PREFIX);
}

SaveSerializer.prototype = {
  /**
   * Enqueues an operation to a list to serialise their execution in order to prevent race
   * conditions. Useful to serialise access to disk.
   *
   * @param {Function} aFunction The task function to enqueue. It must return a promise.
   * @return {Promise} A promise resolved when the enqueued task completes.
   */
  enqueueTask: function (aFunction) {
    let promise = new Promise((resolve, reject) =>
      this._queuedOperations.push([aFunction, resolve, reject]));

    if (this._queuedOperations.length == 1) {
      this._popAndPerformQueuedOperation();
    }
    return promise;
  },

  /**
   * Make sure to flush all the pending operations.
   * @return {Promise} A promise resolved when all the pending operations have completed.
   */
  flushTasks: function () {
    let dummyTask = () => new Promise(resolve => resolve());
    return this.enqueueTask(dummyTask);
  },

  /**
   * Pop a task from the queue, executes it and continue to the next one.
   * This function recursively pops all the tasks.
   */
  _popAndPerformQueuedOperation: function () {
    if (!this._queuedOperations.length || this._queuedInProgress) {
      return;
    }

    this._log.trace("_popAndPerformQueuedOperation - Performing queued operation.");
    let [func, resolve, reject] = this._queuedOperations.shift();
    let promise;

    try {
      this._queuedInProgress = true;
      promise = func();
    } catch (ex) {
      this._log.warn("_popAndPerformQueuedOperation - Queued operation threw during execution. ",
                     ex);
      this._queuedInProgress = false;
      reject(ex);
      this._popAndPerformQueuedOperation();
      return;
    }

    if (!promise || typeof(promise.then) != "function") {
      let msg = "Queued operation did not return a promise: " + func;
      this._log.warn("_popAndPerformQueuedOperation - " + msg);

      this._queuedInProgress = false;
      reject(new Error(msg));
      this._popAndPerformQueuedOperation();
      return;
    }

    promise.then(result => {
        this._queuedInProgress = false;
        resolve(result);
        this._popAndPerformQueuedOperation();
      },
      error => {
        this._log.warn("_popAndPerformQueuedOperation - Failure when performing queued operation.",
                       error);
        this._queuedInProgress = false;
        reject(error);
        this._popAndPerformQueuedOperation();
      });
  },
};

let TelemetryStorageImpl = {
  _logger: null,
  // Used to serialize aborted session ping writes to disk.
  _abortedSessionSerializer: new SaveSerializer(),

  // Tracks the archived pings in a Map of (id -> {timestampCreated, type}).
  // We use this to cache info on archived pings to avoid scanning the disk more than once.
  _archivedPings: new Map(),
  // Track the archive loading task to prevent multiple tasks from being executed.
  _archiveCleanTaskArchiveLoadingTask: null,
  // Track the archive cleanup task.
  _archiveCleanTask: null,
  // Whether we already scanned the archived pings on disk.
  _scannedArchiveDirectory: false,

  // Track the shutdown process to bail out of the clean up task quickly.
  _shutdown: false,

  get _log() {
    if (!this._logger) {
      this._logger = Log.repository.getLoggerWithMessagePrefix(LOGGER_NAME, LOGGER_PREFIX);
    }

    return this._logger;
  },

  /**
   * Shutdown & block on any outstanding async activity in this module.
   *
   * @return {Promise} Promise that is resolved when shutdown is complete.
   */
  shutdown: Task.async(function*() {
    this._shutdown = true;
    yield this._abortedSessionSerializer.flushTasks();
    // If the archive cleaning task is running, block on it. It should bail out as soon
    // as possible.
    yield this._archiveCleanTask;
  }),

  /**
   * Save an archived ping to disk.
   *
   * @param {object} ping The ping data to archive.
   * @return {promise} Promise that is resolved when the ping is successfully archived.
   */
  saveArchivedPing: Task.async(function*(ping) {
    const creationDate = new Date(ping.creationDate);
    if (this._archivedPings.has(ping.id)) {
      const data = this._archivedPings.get(ping.id);
      if (data.timestampCreated > creationDate.getTime()) {
        this._log.error("saveArchivedPing - trying to overwrite newer ping with the same id");
        return Promise.reject(new Error("trying to overwrite newer ping with the same id"));
      } else {
        this._log.warn("saveArchivedPing - overwriting older ping with the same id");
      }
    }

    // Get the archived ping path and append the lz4 suffix to it (so we have 'jsonlz4').
    const filePath = getArchivedPingPath(ping.id, creationDate, ping.type) + "lz4";
    yield OS.File.makeDir(OS.Path.dirname(filePath), { ignoreExisting: true,
                                                       from: OS.Constants.Path.profileDir });
    yield this.savePingToFile(ping, filePath, /*overwrite*/ true, /*compressed*/ true);

    this._archivedPings.set(ping.id, {
      timestampCreated: creationDate.getTime(),
      type: ping.type,
    });
  }),

  /**
   * Load an archived ping from disk.
   *
   * @param {string} id The pings id.
   * @return {promise<object>} Promise that is resolved with the ping data.
   */
  loadArchivedPing: Task.async(function*(id) {
    this._log.trace("loadArchivedPing - id: " + id);

    const data = this._archivedPings.get(id);
    if (!data) {
      this._log.trace("loadArchivedPing - no ping with id: " + id);
      return Promise.reject(new Error("TelemetryStorage.loadArchivedPing - no ping with id " + id));
    }

    const path = getArchivedPingPath(id, new Date(data.timestampCreated), data.type);
    const pathCompressed = path + "lz4";

    try {
      // Try to load a compressed version of the archived ping first.
      this._log.trace("loadArchivedPing - loading ping from: " + pathCompressed);
      return yield this.loadPingFile(pathCompressed, /*compressed*/ true);
    } catch (ex if ex.becauseNoSuchFile) {
      // If that fails, look for the uncompressed version.
      this._log.trace("loadArchivedPing - compressed ping not found, loading: " + path);
      return yield this.loadPingFile(path, /*compressed*/ false);
    }
  }),

  /**
   * Remove an archived ping from disk.
   *
   * @param {string} id The pings id.
   * @param {number} timestampCreated The pings creation timestamp.
   * @param {string} type The pings type.
   * @return {promise<object>} Promise that is resolved when the pings is removed.
   */
  _removeArchivedPing: Task.async(function*(id, timestampCreated, type) {
    this._log.trace("_removeArchivedPing - id: " + id + ", timestampCreated: " + timestampCreated + ", type: " + type);
    const path = getArchivedPingPath(id, new Date(timestampCreated), type);
    const pathCompressed = path + "lz4";

    this._log.trace("_removeArchivedPing - removing ping from: " + path);
    yield OS.File.remove(path, {ignoreAbsent: true});
    yield OS.File.remove(pathCompressed, {ignoreAbsent: true});
  }),

  /**
   * Clean the pings archive by removing old pings.
   *
   * @return {Promise} Resolved when the cleanup task completes.
   */
  runCleanPingArchiveTask: function() {
    // If there's an archive cleaning task already running, return it.
    if (this._archiveCleanTask) {
      return this._archiveCleanTask;
    }

    // Make sure to clear |_archiveCleanTask| once done.
    let clear = () => this._archiveCleanTask = null;
    // Since there's no archive cleaning task running, start it.
    this._archiveCleanTask = this.cleanArchiveTask().then(clear, clear);
    return this._archiveCleanTask;
  },

  cleanArchiveTask: Task.async(function*() {
    this._log.trace("cleanArchiveTask");

    if (!(yield OS.File.exists(gPingsArchivePath))) {
      return;
    }

    const now = Policy.now().getTime();
    let dirIterator = new OS.File.DirectoryIterator(gPingsArchivePath);
    let subdirs = (yield dirIterator.nextBatch()).filter(e => e.isDir);

    // Keep track of the newest removed month to update the cache, if needed.
    let newestRemovedMonth = null;

    // Walk through the monthly subdirs of the form <YYYY-MM>/
    for (let dir of subdirs) {
      if (this._shutdown) {
        this._log.trace("cleanArchiveTask - Terminating the clean up task due to shutdown");
        return;
      }

      if (!isValidArchiveDir(dir.name)) {
        this._log.warn("cleanArchiveTask - skipping invalidly named subdirectory " + dir.path);
        continue;
      }

      const archiveDate = getDateFromArchiveDir(dir.name);
      if (!archiveDate) {
        this._log.warn("cleanArchiveTask - skipping invalid subdirectory date " + dir.path);
        continue;
      }

      // If this archive directory is older than 180 days, remove it.
      if (!TelemetryUtils.areTimesClose(archiveDate.getTime(), now,
                                        MAX_ARCHIVED_PINGS_RETENTION_MS)) {
        try {
          yield OS.File.removeDir(dir.path);

          // Update the newest removed month.
          if (archiveDate > newestRemovedMonth) {
            newestRemovedMonth = archiveDate;
          }
        } catch (ex) {
          this._log.error("cleanArchiveTask - Unable to remove " + dir.path, ex);
        }
      }
    }

    // If the archive directory was already scanned, filter the ping archive cache.
    if (this._scannedArchiveDirectory && newestRemovedMonth) {
      // Scan the archive cache for pings older than the newest directory pruned above.
      for (let [id, info] of this._archivedPings) {
        const timestampCreated = new Date(info.timestampCreated);
        if (timestampCreated.getTime() > newestRemovedMonth.getTime()) {
          continue;
        }
        // Remove outdated pings from the cache.
        this._archivedPings.delete(id);
      }
    }
  }),

  /**
   * Reset the storage state in tests.
   */
  reset: function() {
    this._shutdown = false;
    this._scannedArchiveDirectory = false;
    this._archivedPings = new Map();
  },

  /**
   * Get a list of info on the archived pings.
   * This will scan the archive directory and grab basic data about the existing
   * pings out of their filename.
   *
   * @return {promise<sequence<object>>}
   */
  loadArchivedPingList: function() {
    // If there's an archive loading task already running, return it.
    if (this._archiveScanningTask) {
      return this._archiveScanningTask;
    }

    if (this._scannedArchiveDirectory) {
      this._log.trace("loadArchivedPingList - Archive already scanned, hitting cache.");
      return Promise.resolve(this._archivedPings);
    }

    // Make sure to clear |_archiveScanningTask| once done.
    let clear = pingList => {
      this._archiveScanningTask = null;
      return pingList;
    };
    // Since there's no archive loading task running, start it.
    this._archiveScanningTask = this._scanArchive().then(clear, clear);
    return this._archiveScanningTask;
  },

  _scanArchive: Task.async(function*() {
    this._log.trace("_scanArchive");

    if (!(yield OS.File.exists(gPingsArchivePath))) {
      return new Map();
    }

    let dirIterator = new OS.File.DirectoryIterator(gPingsArchivePath);
    let subdirs = (yield dirIterator.nextBatch()).filter(e => e.isDir);

    // Walk through the monthly subdirs of the form <YYYY-MM>/
    for (let dir of subdirs) {
      if (!isValidArchiveDir(dir.name)) {
        this._log.warn("_scanArchive - skipping invalidly named subdirectory " + dir.path);
        continue;
      }

      this._log.trace("_scanArchive - checking in subdir: " + dir.path);
      let pingIterator = new OS.File.DirectoryIterator(dir.path);
      let pings = (yield pingIterator.nextBatch()).filter(e => !e.isDir);

      // Now process any ping files of the form "<timestamp>.<uuid>.<type>.[json|jsonlz4]".
      for (let p of pings) {
        // data may be null if the filename doesn't match the above format.
        let data = this._getArchivedPingDataFromFileName(p.name);
        if (!data) {
          continue;
        }

        // In case of conflicts, overwrite only with newer pings.
        if (this._archivedPings.has(data.id)) {
          const overwrite = data.timestamp > this._archivedPings.get(data.id).timestampCreated;
          this._log.warn("_scanArchive - have seen this id before: " + data.id +
                         ", overwrite: " + overwrite);
          if (!overwrite) {
            continue;
          }

          yield this._removeArchivedPing(data.id, data.timestampCreated, data.type)
                    .catch((e) => this._log.warn("_scanArchive - failed to remove ping", e));
        }

        this._archivedPings.set(data.id, {
          timestampCreated: data.timestamp,
          type: data.type,
        });
      }
    }

    // Mark the archive as scanned, so we no longer hit the disk.
    this._scannedArchiveDirectory = true;
    return this._archivedPings;
  }),

  /**
   * Save a single ping to a file.
   *
   * @param {object} ping The content of the ping to save.
   * @param {string} file The destination file.
   * @param {bool} overwrite If |true|, the file will be overwritten if it exists,
   * if |false| the file will not be overwritten and no error will be reported if
   * the file exists.
   * @param {bool} [compress=false] If |true|, the file will use lz4 compression. Otherwise no
   * compression will be used.
   * @returns {promise}
   */
  savePingToFile: function(ping, filePath, overwrite, compress = false) {
    return Task.spawn(function*() {
      try {
        let pingString = JSON.stringify(ping);
        let options = { tmpPath: filePath + ".tmp", noOverwrite: !overwrite };
        if (compress) {
          options.compression = "lz4";
        }
        yield OS.File.writeAtomic(filePath, pingString, options);
      } catch(e if e.becauseExists) {
      }
    })
  },

  /**
   * Save a ping to its file.
   *
   * @param {object} ping The content of the ping to save.
   * @param {bool} overwrite If |true|, the file will be overwritten
   * if it exists.
   * @returns {promise}
   */
  savePing: function(ping, overwrite) {
    return Task.spawn(function*() {
      yield getPingDirectory();
      let file = pingFilePath(ping);
      yield this.savePingToFile(ping, file, overwrite);
    }.bind(this));
  },

  /**
   * Save all pending pings.
   *
   * @param {object} sessionPing The additional session ping.
   * @returns {promise}
   */
  savePendingPings: function(sessionPing) {
    let p = pendingPings.reduce((p, ping) => {
      // Restore the files with the previous pings if for some reason they have
      // been deleted, don't overwrite them otherwise.
      p.push(this.savePing(ping, false));
      return p;}, [this.savePing(sessionPing, true)]);

    pendingPings = [];
    return Promise.all(p);
  },

  /**
   * Add a ping from an existing file to the saved pings directory so that it gets saved
   * and sent along with other pings.
   * Note: that the original ping file will not be modified.
   *
   * @param {String} pingPath The path to the ping file that needs to be added to the
   *                           saved pings directory.
   * @return {Promise} A promise resolved when the ping is saved to the pings directory.
   */
  addPendingPingFromFile: function(pingPath) {
    // Pings in the saved ping directory need to have the ping id or slug (old format) as
    // the file name. We load the ping content, check that it is valid, and use it to save
    // the ping file with the correct file name.
    return this.loadPingFile(pingPath).then(ping => {
      // Since we read a ping successfully, update the related histogram.
      Telemetry.getHistogramById("READ_SAVED_PING_SUCCESS").add(1);
      return this.addPendingPing(ping);
    });
  },

  /**
   * Add a ping to the saved pings directory so that it gets saved
   * and sent along with other pings.
   * Note: that the original ping file will not be modified.
   *
   * @param {Object} ping The ping object.
   * @return {Promise} A promise resolved when the ping is saved to the pings directory.
   */
  addPendingPing: function(ping) {
    // Append the ping to the pending list.
    pendingPings.push(ping);
    // Save the ping to the saved pings directory.
    return this.savePing(ping, false);
  },

  /**
   * Remove the file for a ping
   *
   * @param {object} ping The ping.
   * @returns {promise}
   */
  cleanupPingFile: function(ping) {
    return OS.File.remove(pingFilePath(ping));
  },

  /**
   * Load all saved pings.
   *
   * Once loaded, the saved pings can be accessed (destructively only)
   * through |popPendingPings|.
   *
   * @returns {promise}
   */
  loadSavedPings: function() {
    return Task.spawn(function*() {
      let directory = TelemetryStorage.pingDirectoryPath;
      let iter = new OS.File.DirectoryIterator(directory);
      let exists = yield iter.exists();

      if (exists) {
        let entries = yield iter.nextBatch();
        let sortedEntries = [];

        for (let entry of entries) {
          if (entry.isDir) {
            continue;
          }

          let info = yield OS.File.stat(entry.path);
          sortedEntries.push({entry:entry, lastModificationDate: info.lastModificationDate});
        }

        sortedEntries.sort(function compare(a, b) {
          return b.lastModificationDate - a.lastModificationDate;
        });

        let count = 0;
        let result = [];

        // Keep only the last MAX_LRU_PINGS entries to avoid that the backlog overgrows.
        for (let i = 0; i < MAX_LRU_PINGS && i < sortedEntries.length; i++) {
          let entry = sortedEntries[i].entry;
          result.push(this.loadHistograms(entry.path))
        }

        for (let i = MAX_LRU_PINGS; i < sortedEntries.length; i++) {
          let entry = sortedEntries[i].entry;
          OS.File.remove(entry.path);
        }

        yield Promise.all(result);

        Services.telemetry.getHistogramById('TELEMETRY_FILES_EVICTED').
          add(sortedEntries.length - MAX_LRU_PINGS);
      }

      yield iter.close();
    }.bind(this));
  },

  /**
   * Load the histograms from a file.
   *
   * Once loaded, the saved pings can be accessed (destructively only)
   * through |popPendingPings|.
   *
   * @param {string} file The file to load.
   * @returns {promise}
   */
  loadHistograms: function loadHistograms(file) {
    return OS.File.stat(file).then(function(info){
      let now = Date.now();
      if (now - info.lastModificationDate > MAX_PING_FILE_AGE) {
        // We haven't had much luck in sending this file; delete it.
        pingsDiscarded++;
        return OS.File.remove(file);
      }

      // This file is a bit stale, and overdue for sending.
      if (now - info.lastModificationDate > OVERDUE_PING_FILE_AGE) {
        pingsOverdue++;
      }

      pingsLoaded++;
      return addToPendingPings(file);
    });
  },

  /**
   * The number of pings loaded since the beginning of time.
   */
  get pingsLoaded() {
    return pingsLoaded;
  },

  /**
   * The number of pings loaded that are older than OVERDUE_PING_FILE_AGE
   * but younger than MAX_PING_FILE_AGE.
   */
  get pingsOverdue() {
    return pingsOverdue;
  },

  /**
   * The number of pings that we just tossed out for being older than
   * MAX_PING_FILE_AGE.
   */
  get pingsDiscarded() {
    return pingsDiscarded;
  },

  testLoadHistograms: function(file) {
    pingsLoaded = 0;
    return this.loadHistograms(file.path);
  },

  /**
   * Loads a ping file.
   * @param {String} aFilePath The path of the ping file.
   * @param {Boolean} [aCompressed=false] If |true|, expects the file to be compressed using lz4.
   * @return {Promise<Object>} A promise resolved with the ping content or rejected if the
   *                           ping contains invalid data.
   */
  loadPingFile: Task.async(function* (aFilePath, aCompressed = false) {
    let options = {};
    if (aCompressed) {
      options.compression = "lz4";
    }
    let array = yield OS.File.read(aFilePath, options);
    let decoder = new TextDecoder();
    let string = decoder.decode(array);

    let ping = JSON.parse(string);
    // The ping's payload used to be stringified JSON.  Deal with that.
    if (typeof(ping.payload) == "string") {
      ping.payload = JSON.parse(ping.payload);
    }
    return ping;
  }),

  /**
   * Archived pings are saved with file names of the form:
   * "<timestamp>.<uuid>.<type>.[json|jsonlz4]"
   * This helper extracts that data from a given filename.
   *
   * @param fileName {String} The filename.
   * @return {Object} Null if the filename didn't match the expected form.
   *                  Otherwise an object with the extracted data in the form:
   *                  { timestamp: <number>,
   *                    id: <string>,
   *                    type: <string> }
   */
  _getArchivedPingDataFromFileName: function(fileName) {
    // Extract the parts.
    let parts = fileName.split(".");
    if (parts.length != 4) {
      this._log.trace("_getArchivedPingDataFromFileName - should have 4 parts");
      return null;
    }

    let [timestamp, uuid, type, extension] = parts;
    if (extension != "json" && extension != "jsonlz4") {
      this._log.trace("_getArchivedPingDataFromFileName - should have 'json' or 'jsonlz4' extension");
      return null;
    }

    // Check for a valid timestamp.
    timestamp = parseInt(timestamp);
    if (Number.isNaN(timestamp)) {
      this._log.trace("_getArchivedPingDataFromFileName - should have a valid timestamp");
      return null;
    }

    // Check for a valid UUID.
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(uuid)) {
      this._log.trace("_getArchivedPingDataFromFileName - should have a valid id");
      return null;
    }

    // Check for a valid type string.
    const typeRegex = /^[a-z0-9][a-z0-9-]+[a-z0-9]$/i;
    if (!typeRegex.test(type)) {
      this._log.trace("_getArchivedPingDataFromFileName - should have a valid type");
      return null;
    }

    return {
      timestamp: timestamp,
      id: uuid,
      type: type,
    };
  },

  saveAbortedSessionPing: Task.async(function*(ping) {
    this._log.trace("saveAbortedSessionPing - ping path: " + gAbortedSessionFilePath);
    yield OS.File.makeDir(gDataReportingDir, { ignoreExisting: true });

    return this._abortedSessionSerializer.enqueueTask(() =>
      this.savePingToFile(ping, gAbortedSessionFilePath, true));
  }),

  loadAbortedSessionPing: Task.async(function*() {
    let ping = null;
    try {
      ping = yield this.loadPingFile(gAbortedSessionFilePath);
    } catch (ex if ex.becauseNoSuchFile) {
      this._log.trace("loadAbortedSessionPing - no such file");
    } catch (ex) {
      this._log.error("loadAbortedSessionPing - error removing ping", ex)
    }
    return ping;
  }),

  removeAbortedSessionPing: function() {
    return this._abortedSessionSerializer.enqueueTask(Task.async(function*() {
      try {
        yield OS.File.remove(gAbortedSessionFilePath, { ignoreAbsent: false });
        this._log.trace("removeAbortedSessionPing - success");
      } catch (ex if ex.becauseNoSuchFile) {
        this._log.trace("removeAbortedSessionPing - no such file");
      } catch (ex) {
        this._log.error("removeAbortedSessionPing - error removing ping", ex)
      }
    }.bind(this)));
  },
};

///// Utility functions

function pingFilePath(ping) {
  // Support legacy ping formats, who don't have an "id" field, but a "slug" field.
  let pingIdentifier = (ping.slug) ? ping.slug : ping.id;
  return OS.Path.join(TelemetryStorage.pingDirectoryPath, pingIdentifier);
}

function getPingDirectory() {
  return Task.spawn(function*() {
    let directory = TelemetryStorage.pingDirectoryPath;

    if (!isPingDirectoryCreated) {
      yield OS.File.makeDir(directory, { unixMode: OS.Constants.S_IRWXU });
      isPingDirectoryCreated = true;
    }

    return directory;
  });
}

function addToPendingPings(file) {
  function onLoad(success) {
    let success_histogram = Telemetry.getHistogramById("READ_SAVED_PING_SUCCESS");
    success_histogram.add(success);
  }

  return TelemetryStorage.loadPingFile(file).then(ping => {
      pendingPings.push(ping);
      onLoad(true);
    },
    () => {
      onLoad(false);
      return OS.File.remove(file);
    });
}

/**
 * Build the path to the archived ping.
 * @param {String} aPingId The ping id.
 * @param {Object} aDate The ping creation date.
 * @param {String} aType The ping type.
 * @return {String} The full path to the archived ping.
 */
function getArchivedPingPath(aPingId, aDate, aType) {
  // Helper to pad the month to 2 digits, if needed (e.g. "1" -> "01").
  let addLeftPadding = value => (value < 10) ? ("0" + value) : value;
  // Get the ping creation date and generate the archive directory to hold it. Note
  // that getMonth returns a 0-based month, so we need to add an offset.
  let archivedPingDir = OS.Path.join(gPingsArchivePath,
    aDate.getFullYear() + '-' + addLeftPadding(aDate.getMonth() + 1));
  // Generate the archived ping file path as YYYY-MM/<TIMESTAMP>.UUID.type.json
  let fileName = [aDate.getTime(), aPingId, aType, "json"].join(".");
  return OS.Path.join(archivedPingDir, fileName);
}

/**
 * Check if a directory name is in the "YYYY-MM" format.
 * @param {String} aDirName The name of the pings archive directory.
 * @return {Boolean} True if the directory name is in the right format, false otherwise.
 */
function isValidArchiveDir(aDirName) {
  const dirRegEx = /^[0-9]{4}-[0-9]{2}$/;
  return dirRegEx.test(aDirName);
}

/**
 * Gets a date object from an archive directory name.
 * @param {String} aDirName The name of the pings archive directory. Must be in the YYYY-MM
 *        format.
 * @return {Object} A Date object or null if the dir name is not valid.
 */
function getDateFromArchiveDir(aDirName) {
  let [year, month] = aDirName.split("-");
  year = parseInt(year);
  month = parseInt(month);
  // Make sure to have sane numbers.
  if (!Number.isFinite(month) || !Number.isFinite(year) || month < 1 || month > 12) {
    return null;
  }
  return new Date(year, month - 1, 1, 0, 0, 0);
}
