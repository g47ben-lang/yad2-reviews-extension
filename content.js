// שרת הייצור בענן. לפיתוח מקומי החלף ל: 'http://localhost:3000'
const SERVER_URL = 'https://yad2-reviews-server.onrender.com';
let currentUrl = window.location.href;

// 1. זיהוי אמין למעברי עמודים באתרי SPA (ללא ריענון מלא)
setInterval(() => {
    if (window.location.href !== currentUrl) {
        currentUrl = window.location.href;
        init(); 
    }
}, 800);

let feedObserver = null;
let feedSafetyInterval = null;

// מטמון לתוצאות batch-check כדי לא להציף את השרת בסריקות חוזרות
let lastBatchSignature = '';
let lastBatchResult = {};
let lastBatchTime = 0;

function isFeedPage() {
    const url = window.location.href;
    return url.includes('/vehicles/') && !url.includes('/item/');
}

function init() {
    stopFeedWatch();
    const url = window.location.href;

    if (url.includes('/item/')) {
        setTimeout(injectItemPage, 1000);
        setTimeout(injectItemPage, 2500);
    } else if (url.includes('/vehicles/')) {
        startFeedWatch();
    }
}

// עדכון חי של הסמלים בפיד במקרה של שינוי מטאב אחר
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && isFeedPage()) {
        injectFeedPage();
    }
});

// יד 2 בנוי על React ומרנדר מחדש כרטיסים תוך כדי גלילה, מה שמוחק סמלים שהזרקנו.
// במקום סריקה כל 2 שניות אנחנו מאזינים לשינויים ב-DOM ומזריקים מחדש מיד.
// injectFeedPage הוא idempotent (משנה DOM רק כשמשהו באמת השתנה) כדי שלא ניצור לולאה אינסופית מול המשקיף.
function startFeedWatch() {
    injectFeedPage();

    if (!feedObserver) {
        const debounced = debounce(() => {
            if (isFeedPage()) injectFeedPage();
        }, 350);
        feedObserver = new MutationObserver(debounced);
        feedObserver.observe(document.body, { childList: true, subtree: true });
    }

    // רשת ביטחון: סריקה איטית נוספת למקרה שהמשקיף פספס משהו (לא יקר כי ההזרקה idempotent)
    if (!feedSafetyInterval) {
        feedSafetyInterval = setInterval(() => {
            if (isFeedPage()) injectFeedPage();
        }, 3000);
    }
}

function stopFeedWatch() {
    if (feedObserver) { feedObserver.disconnect(); feedObserver = null; }
    if (feedSafetyInterval) { clearInterval(feedSafetyInterval); feedSafetyInterval = null; }
}

// ביד2 כל כרטיס מודעה הוא תגית <a> בפני עצמה (עם data-testid ששווה למזהה המודעה),
// וכל הכרטיסים יושבים ישירות תחת feedListBox אחד. לכן הכרטיס = הקישור עצמו,
// ומודעה מוקפצת שמופיעה כמה פעמים = כמה תגיות <a> נפרדות שכל אחת תקבל סמל.
async function injectFeedPage() {
    const itemLinks = document.querySelectorAll('a[href*="/item/"]');

    const cards = new Map(); // cardElement (<a>) -> itemId
    itemLinks.forEach(link => {
        // data-testid מדויק יותר מפירוק ה-href, עם נפילה חזרה ל-href אם חסר
        const id = link.getAttribute('data-testid') || (link.href.match(/item\/([a-zA-Z0-9-]+)/) || [])[1];
        if (id) cards.set(link, id);
    });

    if (cards.size === 0) return;

    const itemIds = [...new Set(cards.values())];
    let publicReviews = {};

    // שליחת batch-check רק כשרשימת המודעות השתנתה או שעברה דקה - חוסך מאות בקשות לשרת
    const signature = itemIds.slice().sort().join(',');
    if (signature === lastBatchSignature && Date.now() - lastBatchTime < 60000) {
        publicReviews = lastBatchResult;
    } else {
        try {
            const response = await fetch(`${SERVER_URL}/api/batch-check`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ itemIds })
            });
            if (response.ok) {
                publicReviews = await response.json();
                lastBatchSignature = signature;
                lastBatchResult = publicReviews;
                lastBatchTime = Date.now();
            }
        } catch (e) {
            // התעלמות במקרה של שגיאת רשת מול השרת
        }
    }

    chrome.storage.local.get(itemIds, (localData) => {
        cards.forEach((id, card) => {
            const status = localData[id]?.status;
            const note = localData[id]?.note;
            const hasPublic = !!publicReviews[id];

            const badges = [];
            if (status === 'irrelevant') {
                badges.push(feedBadge('#dc3545', '🚫 לא רלוונטי'));
            } else {
                if (status === 'interesting') badges.push(feedBadge('#28a745', '⭐ מעניין'));
                if (hasPublic) badges.push(feedBadge('#ff7100', '🌍 חוות דעת'));
                if (note && note.trim() !== '') badges.push(feedBadge('#6c757d', '🔒 הערה אישית'));
            }

            // חתימת המצב הרצוי. נשמרת על אלמנט הסמל עצמו כדי שאם React ימחק אותו ברינדור מחדש -
            // נזהה שהוא נעלם ונזריק שוב. כשהמצב כבר תואם, לא נוגעים ב-DOM (idempotent, בלי לולאה מול המשקיף).
            const desiredSig = badges.length ? `${status || '-'}|${note && note.trim() ? '1' : '0'}|${hasPublic ? '1' : '0'}` : '';
            const existing = card.querySelector(':scope > .v-badge-container');
            const currentSig = existing ? existing.getAttribute('data-sig') : '';
            if (currentSig === desiredSig) return;

            if (existing) existing.remove();

            // שקיפות מופחתת למודעה "לא רלוונטית"
            card.style.setProperty('opacity', status === 'irrelevant' ? '0.35' : '1', 'important');

            if (badges.length === 0) return;

            const badgeContainer = document.createElement('div');
            badgeContainer.className = 'v-badge-container';
            badgeContainer.setAttribute('data-sig', desiredSig);
            badgeContainer.style.cssText = 'position: absolute !important; top: 8px !important; right: 8px !important; z-index: 2147483647 !important; display: flex !important; flex-direction: column !important; gap: 6px !important; pointer-events: none !important;';
            badgeContainer.innerHTML = badges.join('');

            if (getComputedStyle(card).position === 'static') {
                card.style.setProperty('position', 'relative', 'important');
            }
            card.appendChild(badgeContainer);
        });
    });
}

function feedBadge(color, text) {
    return `<span style="background:${color} !important; color:#fff !important; padding:4px 8px !important; border-radius:4px !important; font-weight:bold !important; font-size:13px !important; box-shadow:0 2px 6px rgba(0,0,0,0.6) !important; border:1px solid white !important; white-space:nowrap !important;">${text}</span>`;
}

// escape בסיסי לטקסט שמגיע מהשרת לפני הזרקה ל-HTML
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let myProfileName = null; // שם התצוגה שלי בקהילה (נשמר מקומית) - כדי לסמן "חוות הדעת שלי"

async function injectItemPage() {
    if (document.getElementById('vc-launcher')) return;

    const match = window.location.href.match(/item\/([a-zA-Z0-9-]+)/);
    const itemId = match ? match[1] : null;
    if (!itemId) return;

    // כפתור קטן צף שתמיד נוכח בעמוד המודעה
    const launcher = document.createElement('button');
    launcher.id = 'vc-launcher';
    launcher.type = 'button';
    launcher.innerHTML = `
        <span class="vc-launcher-emoji">🚗</span>
        <span class="vc-launcher-label">בקרת רכבים</span>
        <span class="vc-launcher-count" id="vc-launcher-count" style="display:none">0</span>`;
    document.body.appendChild(launcher);

    // החלון הגדול (מודאל) - מוסתר עד לחיצה
    const modal = document.createElement('div');
    modal.id = 'vc-modal';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="vc-backdrop" data-close="1"></div>
        <div class="vc-card" role="dialog" aria-modal="true" aria-label="בקרת רכבים">
            <div class="vc-card-head">
                <div class="vc-card-title"><span class="vc-card-emoji">🚗</span> בקרת רכבים</div>
                <button class="vc-x" data-close="1" aria-label="סגירה">✕</button>
            </div>
            <div class="vc-tabs">
                <button class="vc-tab is-active" data-tab="community">חוות דעת הקהילה</button>
                <button class="vc-tab" data-tab="write">כתיבת דיווח</button>
                <button class="vc-tab" data-tab="personal">האזור האישי שלי</button>
            </div>
            <div class="vc-card-body">
                <section class="vc-view" data-view="community">
                    <div id="vc-reviews-list" class="vc-reviews">טוען חוות דעת...</div>
                </section>

                <section class="vc-view" data-view="write" style="display:none">
                    <div id="vc-name-box" class="vc-namebox" style="display:none">
                        <div class="vc-label">התחברות ראשונה — בחר שם תצוגה שיופיע ליד חוות הדעת שלך:</div>
                        <input type="text" id="vc-display-name" class="vc-input" maxlength="40" placeholder="לדוגמה: יוסי - מכונאי מהצפון">
                    </div>
                    <label class="vc-label" for="vc-new-review">חוות הדעת שלך על הרכב</label>
                    <textarea id="vc-new-review" class="vc-textarea" placeholder="מה גילית על הרכב? מצב מכני, היסטוריה, התרשמות מהמוכר, אמינות המודעה..."></textarea>
                    <label class="vc-check"><input type="checkbox" id="vc-agree"><span>המידע אמין ונכתב בתום לב, ועומד בכללי הקהילה</span></label>
                    <button id="vc-submit" class="vc-primary-btn">פרסום חוות הדעת</button>
                    <div id="vc-write-status" class="vc-status" style="display:none"></div>
                </section>

                <section class="vc-view" data-view="personal" style="display:none">
                    <div id="vc-my-name" class="vc-myname" style="display:none"></div>
                    <div class="vc-label">סימון המודעה (נשמר במחשב שלך בלבד, לא ציבורי)</div>
                    <div class="vc-marks">
                        <button id="vc-mark-int" class="vc-mark">⭐ מעניין</button>
                        <button id="vc-mark-irr" class="vc-mark">🚫 לא רלוונטי</button>
                    </div>
                    <label class="vc-label" for="vc-private-note">הערה אישית (רק אתה רואה אותה)</label>
                    <textarea id="vc-private-note" class="vc-textarea" placeholder="הערות פרטיות לעצמך על הרכב הזה..."></textarea>
                    <div class="vc-hint">נשמר אוטומטית תוך כדי הקלדה. הסימון וההערה יופיעו כסמל על המודעה בעמוד תוצאות החיפוש.</div>
                </section>
            </div>
        </div>`;
    document.body.appendChild(modal);

    // פתיחה / סגירה
    launcher.addEventListener('click', () => { modal.style.display = 'block'; loadReviews(itemId); });
    modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => { modal.style.display = 'none'; }));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.style.display = 'none'; });

    // מעבר בין לשוניות
    modal.querySelectorAll('.vc-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            modal.querySelectorAll('.vc-tab').forEach(t => t.classList.toggle('is-active', t === tab));
            modal.querySelectorAll('.vc-view').forEach(v => {
                v.style.display = v.getAttribute('data-view') === tab.getAttribute('data-tab') ? 'block' : 'none';
            });
        });
    });

    // טעינת נתונים אישיים מקומיים
    chrome.storage.local.get([itemId, 'vc_profile'], (result) => {
        const d = result[itemId] || {};
        if (d.note) modal.querySelector('#vc-private-note').value = d.note;
        applyMarkUI(modal, d.status);
        myProfileName = result.vc_profile?.displayName || null;
        if (myProfileName) {
            const el = modal.querySelector('#vc-my-name');
            el.style.display = 'block';
            el.innerHTML = `השם שלך בקהילה: <b>${esc(myProfileName)}</b>`;
        }
    });

    // הערה אישית - שמירה אוטומטית
    modal.querySelector('#vc-private-note').addEventListener('input', debounce((e) => {
        updateLocalData(itemId, { note: e.target.value });
    }, 500));

    // סימון מעניין / לא רלוונטי
    modal.querySelector('#vc-mark-int').addEventListener('click', () => toggleStatus(itemId, 'interesting', modal));
    modal.querySelector('#vc-mark-irr').addEventListener('click', () => toggleStatus(itemId, 'irrelevant', modal));

    // שליחת דיווח
    modal.querySelector('#vc-submit').addEventListener('click', () => submitReview(itemId, modal));
    modal.querySelector('#vc-display-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitReview(itemId, modal);
    });

    // טעינה ראשונית של חוות הדעת (מעדכן גם את המונה על הכפתור)
    loadReviews(itemId);
}

function applyMarkUI(modal, status) {
    modal.querySelector('#vc-mark-int').classList.toggle('is-active', status === 'interesting');
    modal.querySelector('#vc-mark-irr').classList.toggle('is-active', status === 'irrelevant');
}

function toggleStatus(itemId, status, modal) {
    const btn = modal.querySelector(status === 'interesting' ? '#vc-mark-int' : '#vc-mark-irr');
    const nowActive = !btn.classList.contains('is-active');
    updateLocalData(itemId, { status: nowActive ? status : null });
    applyMarkUI(modal, nowActive ? status : null);
}

function writeStatus(message, type = 'error') {
    const el = document.getElementById('vc-write-status');
    if (!el) return;
    el.textContent = message;
    el.className = type === 'error' ? 'vc-status vc-status-error' : 'vc-status vc-status-success';
    el.style.display = 'block';
    clearTimeout(writeStatus._timer);
    writeStatus._timer = setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function submitReview(itemId, modal) {
    const text = modal.querySelector('#vc-new-review').value;
    if (text.trim() === '') return writeStatus('יש לכתוב תוכן לחוות הדעת');
    if (!modal.querySelector('#vc-agree').checked) return writeStatus('יש לאשר את כללי הקהילה לפני שליחה');

    const nameBox = modal.querySelector('#vc-name-box');
    const nameVal = modal.querySelector('#vc-display-name').value.trim();
    const displayName = (nameBox.style.display !== 'none' && nameVal) ? nameVal : null;

    chrome.runtime.sendMessage({ action: 'getAuthToken' }, async (response) => {
        if (!response || response.error || !response.token) return writeStatus('חובה להתחבר עם חשבון גוגל כדי לפרסם');
        await sendReviewToServer(itemId, text, response.token, displayName, modal);
    });
}

function updateLocalData(itemId, newData) {
    chrome.storage.local.get([itemId], (result) => {
        const currentData = result[itemId] || {};
        chrome.storage.local.set({ [itemId]: { ...currentData, ...newData } });
    });
}

async function sendReviewToServer(itemId, text, token, displayName, modal) {
    try {
        const body = { text };
        if (displayName) body.displayName = displayName;

        const res = await fetch(`${SERVER_URL}/api/reviews/${itemId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(body)
        });

        if (res.status === 403) {
            const data = await res.json().catch(() => ({}));
            if (data.error === 'require_username') {
                // מבקש שם תצוגה - חושף את השדה בתוך אותה לשונית
                modal.querySelector('#vc-name-box').style.display = 'block';
                modal.querySelector('#vc-display-name').focus();
                writeStatus('בחר שם תצוגה ולחץ שוב על "פרסום חוות הדעת"');
            } else {
                writeStatus(data.error || 'הפעולה נדחתה');
            }
        } else if (res.ok) {
            // שומרים את שם התצוגה מקומית כדי לזהות בעתיד "חוות הדעת שלי"
            if (displayName) {
                myProfileName = displayName;
                chrome.storage.local.set({ vc_profile: { displayName } });
            }
            modal.querySelector('#vc-new-review').value = '';
            modal.querySelector('#vc-agree').checked = false;
            modal.querySelector('#vc-name-box').style.display = 'none';
            writeStatus('חוות הדעת פורסמה בהצלחה', 'success');
            await loadReviews(itemId);
        } else {
            const data = await res.json().catch(() => ({}));
            writeStatus(data.error || 'שגיאה בשמירת הנתונים');
        }
    } catch (e) {
        console.error(e);
        writeStatus('בעיה בחיבור לשרת. ייתכן שהשרת מתעורר משינה — נסה שוב בעוד כחצי דקה.');
    }
}

async function loadReviews(itemId) {
    const list = document.getElementById('vc-reviews-list');
    if (!list) return;
    try {
        const res = await fetch(`${SERVER_URL}/api/reviews/${itemId}`);
        const reviews = await res.json();

        // עדכון המונה על הכפתור הצף
        const countEl = document.getElementById('vc-launcher-count');
        if (countEl) {
            countEl.textContent = reviews.length;
            countEl.style.display = reviews.length ? 'inline-flex' : 'none';
        }

        list.innerHTML = '';
        if (reviews.length === 0) {
            list.innerHTML = '<div class="vc-empty">עדיין אין חוות דעת על הרכב הזה.<br>היה הראשון לדווח מהשטח דרך לשונית "כתיבת דיווח".</div>';
            return;
        }

        reviews.forEach(r => {
            let rank = 'rank-new', rankLabel = 'משתמש חדש';
            if (r.trustedUpvotes >= 20) { rank = 'rank-expert'; rankLabel = 'מומחה'; }
            else if (r.trustedUpvotes >= 5) { rank = 'rank-trusted'; rankLabel = 'אמין'; }

            const mine = myProfileName && r.authorName === myProfileName;

            const div = document.createElement('div');
            div.className = 'vc-review' + (mine ? ' vc-review-mine' : '');
            div.innerHTML = `
                <div class="vc-review-top">
                    <span class="vc-author ${rank}">${esc(r.authorName)}</span>
                    <span class="vc-rank-chip ${rank}">${rankLabel}</span>
                    ${mine ? '<span class="vc-mine-chip">שלך</span>' : ''}
                    <span class="vc-review-date">${esc(r.timestamp)}</span>
                </div>
                <div class="vc-review-text">${esc(r.text)}</div>
                <div class="vc-review-actions">
                    <button class="vc-upvote" data-id="${esc(r.id)}">👍 מועיל (${r.totalVotesOnReview})</button>
                </div>`;
            list.appendChild(div);
        });

        list.querySelectorAll('.vc-upvote').forEach(btn => {
            btn.addEventListener('click', () => upvoteReview(itemId, btn.getAttribute('data-id')));
        });
    } catch (e) {
        list.innerHTML = '<div class="vc-status vc-status-error" style="display:block">שגיאת רשת בטעינת חוות הדעת. ייתכן שהשרת מתעורר משינה — נסה שוב בעוד כחצי דקה. (המידע האישי ממשיך לעבוד)</div>';
    }
}

async function upvoteReview(itemId, reviewId) {
    chrome.runtime.sendMessage({ action: 'getAuthToken' }, async (response) => {
        if (!response || response.error || !response.token) {
            return writeStatus('חובה להתחבר עם חשבון גוגל כדי להצביע');
        }
        try {
            const res = await fetch(`${SERVER_URL}/api/reviews/${itemId}/${reviewId}/upvote`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${response.token}` }
            });
            if (res.ok) {
                loadReviews(itemId);
            } else {
                const data = await res.json().catch(() => ({}));
                writeStatus(data.error || 'ההצבעה נכשלה');
            }
        } catch (e) {
            console.error(e);
            writeStatus('בעיה בחיבור לשרת');
        }
    });
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => { clearTimeout(timeout); func(...args); };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

init();