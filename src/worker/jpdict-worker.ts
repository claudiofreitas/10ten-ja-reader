import {
  allMajorDataSeries,
  cancelUpdateWithRetry,
  clearCachedVersionInfo,
  DataSeries,
  JpdictIdb,
  MajorDataSeries,
  toUpdateErrorState,
  UpdateErrorState,
  updateWithRetry,
} from '@birchill/jpdict-idb';

import { JpdictState } from '../background/jpdict';
import { requestIdleCallbackPromise } from '../utils/request-idle-callback';

import {
  JpdictWorkerMessage,
  leaveBreadcrumb,
  notifyDbStateUpdated,
  notifyDbUpdateComplete,
  notifyError,
} from './jpdict-worker-messages';

declare let self: DedicatedWorkerGlobalScope;

self.onmessage = async (event: MessageEvent) => {
  // We seem to get random events here occasionally. Not sure where they come
  // from.
  if (!event.data) {
    return;
  }

  switch ((event.data as JpdictWorkerMessage).type) {
    case 'querystate':
      if (await dbIsInitialized) {
        doDbStateNotification();
      }
      break;

    case 'update':
      try {
        await updateAllSeries({
          lang: event.data.lang,
          forceUpdate: event.data.force,
        });
      } catch (error) {
        self.postMessage(notifyError({ error }));
      }
      break;

    case 'cancelupdate':
      cancelUpdate();
      break;

    case 'delete':
      if (db) {
        try {
          await db.destroy();
        } catch (error) {
          self.postMessage(notifyError({ error }));
        }
      }
      break;
  }
};

self.onerror = (e) => {
  self.postMessage(notifyError({ error: e.error || e }));
};

let db: JpdictIdb | undefined;

const dbIsInitialized: Promise<boolean> = initDb()
  .then(() => true)
  .catch(() => false);

async function initDb(): Promise<JpdictIdb> {
  let retryCount = 0;
  while (true) {
    if (db) {
      try {
        await db.destroy();
      } catch {
        console.log('Failed to destroy previous database');
      }
    }

    db = new JpdictIdb({ verbose: true });
    db.addChangeListener(doDbStateNotification);

    try {
      await db.ready;
      return db;
    } catch (e) {
      if (retryCount >= 3) {
        console.log(
          'Giving up opening database. Likely in permanent private browsing mode.'
        );
        throw e;
      }
      retryCount++;
      console.log(
        `Failed to open database. Retrying shortly (attempt: ${retryCount})...`
      );
      await requestIdleCallbackPromise({ timeout: 1000 });
    }
  }
}

let currentUpdate:
  | {
      lang: string;
      series: MajorDataSeries;
      forceUpdate: boolean;
    }
  | undefined;

let lastUpdateError: UpdateErrorState | undefined;

async function updateAllSeries({
  lang,
  forceUpdate,
}: {
  lang: string;
  forceUpdate: boolean;
}) {
  if (!(await dbIsInitialized)) {
    return;
  }

  // Check for a current update
  let wasForcedUpdate = false;
  if (currentUpdate) {
    // If the language matches and we're not (newly) forcing an update, then
    // just let the current update run.
    if (
      currentUpdate.lang === lang &&
      (currentUpdate.forceUpdate || !forceUpdate)
    ) {
      return;
    }

    // Otherwise, cancel the current update but make sure to propagate the
    // forced flag if we were forced.
    wasForcedUpdate = currentUpdate.forceUpdate;
    cancelUpdate();
    currentUpdate = undefined;
  }

  const onUpdateError =
    (series: DataSeries) =>
    (params: { error: Error; nextRetry?: Date; retryCount?: number }) => {
      const { error, nextRetry, retryCount } = params;
      if (nextRetry) {
        const diffInMs = nextRetry.getTime() - Date.now();
        self.postMessage(
          leaveBreadcrumb({
            message: `Encountered ${error.name} error updating ${series} database. Retrying in ${diffInMs}ms.`,
          })
        );

        // We don't want to report all download errors since the auto-retry
        // behavior will mean we get too many. Also, we don't care about
        // intermittent failures for users on flaky network connections.
        //
        // However, if a lot of clients are failing multiple times to fetch
        // a particular resource, we want to know.
        if (retryCount === 5) {
          self.postMessage(notifyError({ error, severity: 'warning' }));
        }
      } else if (error.name !== 'AbortError' && error.name !== 'OfflineError') {
        self.postMessage(notifyError({ error }));
      } else {
        self.postMessage(
          leaveBreadcrumb({
            message: `Database update for ${series} database encountered ${error.name} error`,
          })
        );
      }

      lastUpdateError = toUpdateErrorState(params);
      doDbStateNotification();
    };

  const runNextUpdate = () => {
    // Check if we successfully updated a series
    if (currentUpdate) {
      lastUpdateError = undefined;
      self.postMessage(
        leaveBreadcrumb({
          message: `Successfully updated ${currentUpdate.series} database`,
        })
      );
      doDbStateNotification();
    }

    // Cycle through data series
    //
    // We use the following order:
    //
    // 1. Kanji
    // 2. Names
    // 3. Words
    //
    // Although the words dictionary is the most important one, we already have
    // the flat-file version available for words so, if we're going to run out
    // of disk space, it would be good to try and get as much of the other data
    // in first.
    if (!currentUpdate) {
      currentUpdate = {
        lang,
        series: 'kanji',
        forceUpdate: forceUpdate || wasForcedUpdate,
      };
    } else if (currentUpdate.series === 'kanji') {
      currentUpdate.series = 'names';
    } else if (currentUpdate.series === 'names') {
      currentUpdate.series = 'words';
    } else {
      currentUpdate = undefined;
      self.postMessage(notifyDbUpdateComplete(getLatestCheckTime(db!)));
      return;
    }

    if (forceUpdate || wasForcedUpdate) {
      clearCachedVersionInfo();
    }
    void updateWithRetry({
      db: db!,
      series: currentUpdate.series,
      lang,
      onUpdateComplete: runNextUpdate,
      onUpdateError: onUpdateError(currentUpdate.series),
    });
  };

  runNextUpdate();
}

function cancelUpdate() {
  if (!currentUpdate) {
    return;
  }

  cancelUpdateWithRetry({ db: db!, series: currentUpdate.series });
  currentUpdate = undefined;
}

function doDbStateNotification() {
  // Wait until we have finished resolving the database versions before
  // reporting anything.
  if (
    !db ||
    db.words.state === 'init' ||
    db.kanji.state === 'init' ||
    db.radicals.state === 'init' ||
    db.names.state === 'init'
  ) {
    return;
  }

  // Merge update states to show the current / latest update
  const lastCheck = getLatestCheckTime(db!);
  const updateState = currentUpdate
    ? db[currentUpdate.series].updateState
    : { type: <const>'idle', lastCheck };

  const state: JpdictState = {
    words: {
      state: db.words.state,
      version: db.words.version,
    },
    kanji: {
      state: db.kanji.state,
      version: db.kanji.version,
    },
    radicals: {
      state: db.radicals.state,
      version: db.radicals.version,
    },
    names: {
      state: db.names.state,
      version: db.names.version,
    },
    updateState,
    updateError: lastUpdateError,
  };

  try {
    self.postMessage(notifyDbStateUpdated(state));
  } catch (e) {
    console.log('Error posting message');
    console.log(e);
  }
}

function getLatestCheckTime(db: JpdictIdb): Date | null {
  const latestCheckAsNumber = Math.max.apply(
    null,
    allMajorDataSeries.map((series) => db[series].updateState.lastCheck)
  );

  return latestCheckAsNumber !== 0 ? new Date(latestCheckAsNumber) : null;
}
