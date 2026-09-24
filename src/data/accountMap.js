// Classification of G/L accounts (Exact Online "1 - G/L account scheme", Dutch GAAP).
//
// P&L accounts are identified from the data itself: an account is P&L if it appears in the
// P&L workfile, otherwise it is a balance-sheet account. MBR categories for cost accounts come
// from the "Remarks" column of the workfile's section totals (COGS / Personnel / General /
// Interest / Taxes). The mappings below cover what the source files do not state explicitly.

// Revenue accounts -> MBR revenue segment (matches the MBR "ACTUAL" sheet categories).
const REVENUE_SEGMENTS = {
  '8400': 'Airline',
  '8401': 'Airport',
  '8402': 'Forwarder',
  '8403': 'GSA',
  '8404': 'Shipper',
  '8405': 'Other Revenue',
  '8500': 'PY Adjustments',
};

// Balance-sheet grouping. `side` is the side of the balance sheet the account belongs to;
// an account whose closing balance has the opposite sign is flagged as unusual, except `contra`
// accounts (accumulated depreciation, bad-debt provision), whose credit balance on the asset side is normal.
// Based on the Dutch decimal chart of accounts ranges and the account names in the TB.
const BS_ACCOUNTS = {
  '0020': { group: 'Intangible fixed assets', side: 'asset' },
  '0120': { group: 'Intangible fixed assets', side: 'asset', contra: true },
  '0030': { group: 'Tangible fixed assets', side: 'asset' },
  '0130': { group: 'Tangible fixed assets', side: 'asset', contra: true },
  '0201': { group: 'Tangible fixed assets', side: 'asset' },
  '0251': { group: 'Tangible fixed assets', side: 'asset', contra: true },
  '0600': { group: 'Equity', side: 'equity' },
  '0609': { group: 'Equity', side: 'equity' },
  '0650': { group: 'Equity', side: 'equity' },
  '1107': { group: 'Cash and bank', side: 'asset' },
  '1108': { group: 'Cash and bank', side: 'asset' },
  '1197': { group: 'Suspense account', side: 'suspense' },
  '1300': { group: 'Trade receivables', side: 'asset' },
  '1305': { group: 'Trade receivables', side: 'asset', contra: true },
  '1303': { group: 'Other receivables and prepayments', side: 'asset' },
  '1320': { group: 'Other receivables and prepayments', side: 'asset' },
  '1321': { group: 'Other receivables and prepayments', side: 'asset' },
  '1322': { group: 'Other receivables and prepayments', side: 'asset' },
  '1403': { group: 'Receivable from group company (Shanwick B.V.)', side: 'asset' },
  '1520': { group: 'Tax receivables', side: 'asset' },
  '1798': { group: 'Tax receivables', side: 'asset' },
  '1500': { group: 'VAT payable', side: 'liability' },
  '1511': { group: 'VAT payable', side: 'liability' },
  '1512': { group: 'VAT payable', side: 'liability' },
  '1599': { group: 'VAT payable', side: 'liability' },
  '1600': { group: 'Trade payables', side: 'liability' },
  '1610': { group: 'Accrued expenses and other payables', side: 'liability' },
  '1680': { group: 'Accrued expenses and other payables', side: 'liability' },
  '1620': { group: 'Deferred income', side: 'liability' },
  '1670': { group: 'Payroll liabilities', side: 'liability' },
  '1700': { group: 'Payroll liabilities', side: 'liability' },
  '1780': { group: 'Payroll liabilities', side: 'liability' },
  '1781': { group: 'Payroll liabilities', side: 'liability' },
  '1785': { group: 'Payroll liabilities', side: 'liability' },
  '1790': { group: 'Corporate income tax payable', side: 'liability' },
};

// Fallback by code range for accounts not listed above (e.g. new accounts in a later export).
const BS_RANGES = [
  { from: 0, to: 199, group: 'Fixed assets (unmapped)', side: 'asset' },
  { from: 200, to: 599, group: 'Fixed assets (unmapped)', side: 'asset' },
  { from: 600, to: 999, group: 'Equity (unmapped)', side: 'equity' },
  { from: 1000, to: 1199, group: 'Cash and bank (unmapped)', side: 'asset' },
  { from: 1200, to: 1499, group: 'Receivables (unmapped)', side: 'asset' },
  { from: 1500, to: 1999, group: 'Current liabilities (unmapped)', side: 'liability' },
];

const BS_GROUP_ORDER = [
  'Intangible fixed assets', 'Tangible fixed assets', 'Fixed assets (unmapped)',
  'Receivable from group company (Shanwick B.V.)', 'Trade receivables',
  'Other receivables and prepayments', 'Tax receivables', 'Receivables (unmapped)',
  'Cash and bank', 'Cash and bank (unmapped)',
  'Equity', 'Equity (unmapped)',
  'Deferred income', 'Trade payables', 'Accrued expenses and other payables',
  'Payroll liabilities', 'VAT payable', 'Corporate income tax payable',
  'Current liabilities (unmapped)', 'Suspense account',
];

function classifyBalanceSheet(code) {
  if (BS_ACCOUNTS[code]) return { ...BS_ACCOUNTS[code], mapped: true };
  const n = Number(code);
  const r = BS_RANGES.find((x) => n >= x.from && n <= x.to);
  return r ? { group: r.group, side: r.side, mapped: false } : { group: 'Unmapped', side: 'unknown', mapped: false };
}

module.exports = { REVENUE_SEGMENTS, BS_ACCOUNTS, BS_GROUP_ORDER, classifyBalanceSheet };
