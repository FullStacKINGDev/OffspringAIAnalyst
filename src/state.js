// Holds the loaded financial model; reload() re-reads the Data folder (e.g. after new month-end files).
const { loadStore } = require('./data/store');
const { runChecks } = require('./analysis/dataQuality');

let current = null;
let loading = null;

async function reload() {
  loading = (async () => {
    const store = await loadStore();
    store.issues = runChecks(store);
    current = store;
    return store;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

async function getStore() {
  if (loading) return loading;
  return current || reload();
}

module.exports = { reload, getStore };
