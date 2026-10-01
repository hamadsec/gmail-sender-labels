/**
 * Gmail Sender Labels
 *
 * Keeps exactly one sender label on every message in your Inbox:
 *
 *   Senders/amazon.com       companies, grouped by organisation domain
 *   Senders/jane@gmail.com   personal mail providers, one label per person
 *   Senders/_unverified      failed DMARC/DKIM: the From header may be forged
 *
 * The labels mirror the Inbox. Archive a message and its sender label is
 * removed; move it back and the label returns. Everything runs inside your own
 * Google account and nothing is sent anywhere else.
 *
 * Install:   Services → + → Gmail API, paste this file and appsscript.json,
 *            then run setup() once and approve the permissions.
 * Uninstall: run uninstall(). It deletes the Senders labels (your email is
 *            untouched) and the trigger.
 *
 * Limits worth knowing:
 *   - The first scan of a large Inbox can take several runs. Free Gmail
 *     accounts get ~90 minutes of trigger runtime per day; if the scan uses it
 *     up, it simply resumes the next day.
 *   - Mailing lists and forwarders often break DMARC, so some genuine mail
 *     lands in _unverified. Set VERIFY_SENDERS to false to turn this off.
 *   - Organisation domains are approximated (last two parts of the domain,
 *     three for suffixes like co.uk); add your country to MULTI_PART_SUFFIXES.
 */

const CONFIG = {
  ROOT_LABEL: 'Senders',
  UNVERIFIED_LABEL: '_unverified',

  // Label mail whose sender Gmail could not authenticate as _unverified,
  // instead of filing a forged "paypal.com" under Senders/paypal.com.
  VERIFY_SENDERS: true,

  // email.amazon.com and amazon.com share one label.
  GROUP_BY_ORG_DOMAIN: true,

  TRIGGER_MINUTES: 5,
  MAX_RUNTIME_MS: 4.5 * 60 * 1000, // Apps Script kills a run at 6 minutes
  CHECKPOINT_EVERY: 100, // messages between saved progress points

  // Senders on these domains get a label per address, not per domain.
  PERSONAL_DOMAINS: [
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
    'msn.com', 'yahoo.com', 'yahoo.co.uk', 'aol.com', 'icloud.com', 'me.com',
    'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de',
    'mail.com', 'yandex.com', 'zoho.com', 'fastmail.com', 'hey.com',
  ],

  // Two-part public suffixes, so shop.co.uk groups as shop.co.uk, not co.uk.
  MULTI_PART_SUFFIXES: [
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au',
    'co.nz', 'co.jp', 'co.kr', 'co.in', 'co.il', 'co.za', 'com.pk', 'org.pk',
    'edu.pk', 'gov.pk', 'com.br', 'com.mx', 'com.tr', 'com.sg', 'com.my',
    'com.cn', 'com.hk', 'com.sa', 'com.eg',
  ],
};

const STATE_KEY = 'STATE';
const HANDLER = 'processEmails';


/* ---------- Entry points ---------- */

/** Run once after installing. Safe to re-run: existing progress is kept. */
function setup() {
  withLock_(() => {
    getLabels_().getOrCreate(CONFIG.ROOT_LABEL);
    if (!loadState_()) saveState_(newScanState_());
    deleteTriggers_();
    ScriptApp.newTrigger(HANDLER).timeBased()
      .everyMinutes(CONFIG.TRIGGER_MINUTES).create();
    console.log(`Installed: ${HANDLER} runs every ${CONFIG.TRIGGER_MINUTES} minutes.`);
  });
  processEmails();
}

/** Called by the trigger. Scans the Inbox first, then follows Gmail History. */
function processEmails() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('Previous run still active; skipping.');
    return;
  }
  try {
    const deadline = Date.now() + CONFIG.MAX_RUNTIME_MS;
    const state = loadState_() || newScanState_();
    const labels = getLabels_();

    if (state.phase === 'scan') runScan_(state, deadline, labels);
    if (state.phase === 'history' && Date.now() < deadline) {
      runHistory_(state, deadline, labels);
    }
    // Errors are deliberately not swallowed: a failed run shows up in the
    // Executions page and in Google's failure emails.
  } finally {
    lock.releaseLock();
  }
}

/** Re-scan the whole Inbox, e.g. after changing CONFIG. */
function rescan() {
  withLock_(() => saveState_(newScanState_()));
  processEmails();
}

/** Remove the trigger and every Senders label. Your email is not touched. */
function uninstall() {
  withLock_(() => {
    deleteTriggers_();
    const labels = getLabels_();
    const ids = labels.senderIds();
    const root = labels.find(CONFIG.ROOT_LABEL);
    if (root) ids.push(root);
    ids.forEach(id => Gmail.Users.Labels.remove('me', id));
    PropertiesService.getScriptProperties().deleteProperty(STATE_KEY);
    console.log(`Uninstalled: removed ${ids.length} labels and the trigger.`);
  });
}

function status() {
  const triggers = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === HANDLER).length;
  console.log(`Triggers: ${triggers}`);
  console.log(JSON.stringify(loadState_(), null, 2));
}


/* ---------- Sync ---------- */

/**
 * Phase 1: label every message currently in the Inbox.
 * The History ID is taken BEFORE the scan, so anything that changes while the
 * scan runs is replayed afterwards by phase 2.
 */
function runScan_(state, deadline, labels) {
  while (Date.now() < deadline) {
    const options = { labelIds: ['INBOX'], maxResults: 500 };
    if (state.pageToken) options.pageToken = state.pageToken;
    const response = Gmail.Users.Messages.list('me', options);
    const ids = (response.messages || []).map(m => m.id);

    if (processIds_(ids, state, deadline, labels) < ids.length) return;

    if (!response.nextPageToken) {
      Object.assign(state, { phase: 'history', historyId: state.baseline, pageToken: null, index: 0 });
      saveState_(state);
      console.log('Inbox scan complete; following Gmail History from now on.');
      return;
    }
    Object.assign(state, { pageToken: response.nextPageToken, index: 0 });
    saveState_(state);
  }
}

/** Phase 2: reconcile only the messages whose Inbox state changed. */
function runHistory_(state, deadline, labels) {
  while (Date.now() < deadline) {
    const options = {
      startHistoryId: state.historyId,
      maxResults: 500,
      historyTypes: ['messageAdded', 'labelAdded', 'labelRemoved'],
    };
    if (state.pageToken) options.pageToken = state.pageToken;

    let response;
    try {
      response = Gmail.Users.History.list('me', options);
    } catch (e) {
      if (!isNotFound_(e)) throw e;
      // Gmail keeps history for about a week; past that, a rescan is the
      // documented recovery.
      console.warn('History ID expired; rescanning the Inbox.');
      saveState_(newScanState_());
      return;
    }

    const ids = inboxChanges_(response.history || []);
    if (processIds_(ids, state, deadline, labels) < ids.length) return;

    if (response.nextPageToken) {
      Object.assign(state, { pageToken: response.nextPageToken, index: 0 });
      saveState_(state);
      continue;
    }
    // Only advance the History ID once every page has been applied.
    Object.assign(state, { historyId: String(response.historyId), pageToken: null, index: 0 });
    saveState_(state);
    return;
  }
}

/** Message IDs from a history page whose INBOX label may have changed. */
function inboxChanges_(history) {
  const ids = new Set();
  for (const record of history) {
    for (const item of record.messagesAdded || []) {
      // Skips drafts and sent mail, which generate many messageAdded events.
      const labelIds = item.message.labelIds;
      if (!labelIds || labelIds.includes('INBOX')) ids.add(item.message.id);
    }
    for (const item of (record.labelsAdded || []).concat(record.labelsRemoved || [])) {
      if ((item.labelIds || []).includes('INBOX')) ids.add(item.message.id);
    }
  }
  return Array.from(ids); // insertion order, so a resumed page lines up
}

/**
 * Reconciles ids[state.index..], saving progress as it goes. Returns how far
 * it got. A message that fails for a permanent reason is logged and skipped,
 * so one bad message can never stall the sync; a rate-limit error stops the
 * run and the next run resumes at that message.
 */
function processIds_(ids, state, deadline, labels) {
  const batch = newBatch_();
  const checkpoint = i => {
    batch.flush();
    state.index = i;
    saveState_(state);
  };

  let i = state.index || 0;
  for (; i < ids.length && Date.now() < deadline; i++) {
    try {
      reconcile_(ids[i], labels, batch);
    } catch (e) {
      if (isTransient_(e)) {
        checkpoint(i);
        throw e;
      }
      console.warn(`Skipping message ${ids[i]}: ${errorText_(e)}`);
    }
    if ((i + 1) % CONFIG.CHECKPOINT_EVERY === 0) checkpoint(i + 1);
  }
  checkpoint(i);
  return i;
}

/** Make one message's sender labels match its current Inbox state. */
function reconcile_(id, labels, batch) {
  let message;
  try {
    message = Gmail.Users.Messages.get('me', id, {
      format: 'metadata',
      metadataHeaders: ['From', 'Authentication-Results'],
    });
  } catch (e) {
    if (isNotFound_(e)) return; // deleted since the change was recorded
    throw e;
  }

  const labelIds = message.labelIds || [];
  const current = labelIds.filter(l => labels.isSender(l));
  const wanted = labelIds.includes('INBOX')
    ? labels.getOrCreate(senderLabelName_(message))
    : null;

  const add = wanted && !current.includes(wanted) ? [wanted] : [];
  const remove = current.filter(l => l !== wanted);
  if (add.length || remove.length) batch.add(id, add, remove);
}


/* ---------- Sender identity ---------- */

function senderLabelName_(message) {
  const root = CONFIG.ROOT_LABEL + '/';
  const email = parseFrom_(headers_(message, 'From')[0]);
  if (!email) return root + CONFIG.UNVERIFIED_LABEL;

  const domain = email.split('@')[1];
  if (CONFIG.VERIFY_SENDERS && !isAuthenticated_(message, domain)) {
    return root + CONFIG.UNVERIFIED_LABEL;
  }
  if (CONFIG.PERSONAL_DOMAINS.includes(domain)) return root + email;
  return root + (CONFIG.GROUP_BY_ORG_DOMAIN ? orgDomain_(domain) : domain);
}

/**
 * The address in a From header, lowercased. Uses the LAST <...> so a display
 * name such as "security@paypal.com <attacker@evil.test>" can't win.
 */
function parseFrom_(value) {
  if (!value) return null;
  const angle = value.match(/<([^<>]*)>\s*$/);
  const text = (angle ? angle[1] : value).toLowerCase();
  const match = text.match(/[a-z0-9._%+'-]+@(?:[a-z0-9-]+\.)+[a-z]{2,}/);
  return match ? match[0] : null;
}

/**
 * True when Gmail's own Authentication-Results show DMARC or DKIM passing for
 * the From domain's organisation. Only the topmost mx.google.com header is
 * read: Gmail prepends it, and headers further down came from the sender.
 */
function isAuthenticated_(message, fromDomain) {
  if ((message.labelIds || []).includes('SENT')) return true; // your own mail
  const results = headers_(message, 'Authentication-Results')
    .find(v => /^\s*mx\.google\.com\s*;/i.test(v));
  if (!results) return false;

  const org = orgDomain_(fromDomain);
  return results.split(';').some(part => {
    const m = part.match(/\b(?:dmarc|dkim)=pass\b.*?header\.(?:from|i|d)=([^\s;)]+)/is);
    return m && orgDomain_(m[1].split('@').pop().toLowerCase()) === org;
  });
}

function orgDomain_(domain) {
  const parts = domain.split('.');
  const take = CONFIG.MULTI_PART_SUFFIXES.includes(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-take).join('.');
}

function headers_(message, name) {
  const wanted = name.toLowerCase();
  return ((message.payload && message.payload.headers) || [])
    .filter(h => h.name && h.name.toLowerCase() === wanted)
    .map(h => String(h.value || ''));
}


/* ---------- Labels and batching ---------- */

/**
 * One Labels.list per run instead of one per message. Lookups are
 * case-insensitive because Gmail treats "Senders/Amazon.com" and
 * "Senders/amazon.com" as the same name and refuses to create the second.
 */
function getLabels_() {
  const prefix = (CONFIG.ROOT_LABEL + '/').toLowerCase();
  let byName;
  let senderIds;

  const load = () => {
    byName = new Map();
    senderIds = new Set();
    for (const label of Gmail.Users.Labels.list('me').labels || []) {
      const key = label.name.toLowerCase();
      byName.set(key, label.id);
      if (key.startsWith(prefix)) senderIds.add(label.id);
    }
  };
  load();

  return {
    isSender: id => senderIds.has(id),
    senderIds: () => Array.from(senderIds),
    find: name => byName.get(name.toLowerCase()) || null,
    getOrCreate(name) {
      const key = name.toLowerCase();
      if (!byName.has(key)) {
        try {
          const label = Gmail.Users.Labels.create({
            name,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show',
          }, 'me');
          byName.set(key, label.id);
          if (key.startsWith(prefix)) senderIds.add(label.id);
        } catch (e) {
          load(); // created by another run, or under a name Gmail treats as equal
          if (!byName.has(key)) throw e;
        }
      }
      return byName.get(key);
    },
  };
}

/** Groups identical label changes into batchModify calls of up to 1,000 messages. */
function newBatch_() {
  const groups = new Map();
  return {
    add(id, add, remove) {
      const key = add.join(',') + '|' + remove.slice().sort().join(',');
      if (!groups.has(key)) groups.set(key, { add, remove, ids: [] });
      groups.get(key).ids.push(id);
    },
    flush() {
      for (const group of groups.values()) {
        for (let i = 0; i < group.ids.length; i += 1000) {
          const body = { ids: group.ids.slice(i, i + 1000) };
          if (group.add.length) body.addLabelIds = group.add;
          if (group.remove.length) body.removeLabelIds = group.remove;
          Gmail.Users.Messages.batchModify(body, 'me');
        }
      }
      groups.clear();
    },
  };
}


/* ---------- Helpers ---------- */

function newScanState_() {
  return {
    phase: 'scan',
    baseline: String(Gmail.Users.getProfile('me').historyId),
    historyId: null,
    pageToken: null,
    index: 0,
  };
}

function loadState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(STATE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function saveState_(state) {
  PropertiesService.getScriptProperties().setProperty(STATE_KEY, JSON.stringify(state));
}

function deleteTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === HANDLER)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function errorText_(e) {
  return String((e && e.message) || e);
}

function isNotFound_(e) {
  return /not found|\b404\b/i.test(errorText_(e));
}

function isTransient_(e) {
  return /rate limit|quota|too many|backend error|internal error|unavailable|timed? ?out|\b(429|50[0-4])\b/i
    .test(errorText_(e));
}
