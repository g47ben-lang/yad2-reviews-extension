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

async function injectItemPage() {
    if (document.getElementById('vehicle-control-panel')) return;

    const match = window.location.href.match(/item\/([a-zA-Z0-9\-]+)/);
    const itemId = match ? match[1] : null;
    if (!itemId) return;

    const panel = document.createElement('div');
    panel.id = 'vehicle-control-panel';
    panel.innerHTML = `
        <div class="vc-header">בקרת רכבים</div>
        <div class="vc-body">
            <div class="vc-section">
                <div class="vc-title">ניהול אישי (נשמר מקומית)</div>
                <div class="vc-buttons">
                    <button id="btn-interesting" class="vc-btn">⭐ מעניין</button>
                    <button id="btn-irrelevant" class="vc-btn">🚫 לא רלוונטי</button>
                </div>
                <textarea id="private-note" placeholder="הערות לעצמך (יישמר אוטומטית)"></textarea>
            </div>
            <hr>
            <div class="vc-section">
                <div class="vc-title">מידע מהשטח (ציבורי)</div>
                <div id="reviews-list">טוען נתונים...</div>
                <textarea id="new-review-text" placeholder="מה הממצאים שלך על הרכב?"></textarea>
                
                <div style="margin-top: 5px; display: flex; align-items: center; gap: 5px;">
                    <input type="checkbox" id="agree-rules" style="cursor: pointer;">
                    <label for="agree-rules" style="font-size: 11px; cursor: pointer;">המידע אמין ועומד בכללים</label>
                </div>
                <button id="submit-review-btn" class="vc-btn vc-primary">שלח דיווח</button>

                <div id="vc-status" style="display: none;"></div>

                <div id="vc-name-form" style="display: none;">
                    <div class="vc-title">התחברות ראשונה - בחר שם תצוגה שיופיע ליד חוות הדעת שלך:</div>
                    <input type="text" id="vc-display-name" maxlength="40" placeholder="לדוגמה: יוסי - מכונאי מהצפון">
                    <button id="vc-name-confirm" class="vc-btn vc-primary">אישור ופרסום</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    chrome.storage.local.get([itemId], function(result) {
        if (result[itemId]) {
            if (result[itemId].note) document.getElementById('private-note').value = result[itemId].note;
            if (result[itemId].status === 'interesting') document.getElementById('btn-interesting').classList.add('active');
            if (result[itemId].status === 'irrelevant') document.getElementById('btn-irrelevant').classList.add('active');
        }
    });

    document.getElementById('private-note').addEventListener('input', debounce((e) => {
        updateLocalData(itemId, { note: e.target.value });
    }, 500));

    document.getElementById('btn-interesting').addEventListener('click', function() {
        this.classList.toggle('active');
        document.getElementById('btn-irrelevant').classList.remove('active');
        updateLocalData(itemId, { status: this.classList.contains('active') ? 'interesting' : null });
    });

    document.getElementById('btn-irrelevant').addEventListener('click', function() {
        this.classList.toggle('active');
        document.getElementById('btn-interesting').classList.remove('active');
        updateLocalData(itemId, { status: this.classList.contains('active') ? 'irrelevant' : null });
    });

    await loadReviews(itemId);

    document.getElementById('submit-review-btn').addEventListener('click', async () => {
        const text = document.getElementById('new-review-text').value;
        if(text.trim() === "") return showStatus('יש לכתוב תוכן לחוות הדעת');
        if (!document.getElementById('agree-rules').checked) return showStatus('יש לאשר את הכללים לפני שליחה');

        chrome.runtime.sendMessage({ action: 'getAuthToken' }, async (response) => {
            if (!response || response.error || !response.token) return showStatus('חובה להתחבר עם חשבון גוגל כדי לפרסם');
            await sendReviewToServer(itemId, text, response.token);
        });
    });

    // אישור שם תצוגה בהתחברות ראשונה (מחליף את חלונית ה-prompt)
    document.getElementById('vc-name-confirm').addEventListener('click', submitDisplayName);
    document.getElementById('vc-display-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitDisplayName();
    });
}

// שמירת פרטי השליחה עד שהמשתמש יבחר שם תצוגה
let pendingReview = null;

async function submitDisplayName() {
    const name = document.getElementById('vc-display-name').value.trim();
    if (!name) return showStatus('יש להזין שם תצוגה');
    if (!pendingReview) return;
    document.getElementById('vc-name-form').style.display = 'none';
    const { itemId, text, token } = pendingReview;
    pendingReview = null;
    await sendReviewToServer(itemId, text, token, name);
}

// הודעת סטטוס בתוך הפאנל במקום חלונות alert קופצים של הדפדפן
function showStatus(message, type = 'error') {
    const el = document.getElementById('vc-status');
    if (!el) return;
    el.textContent = message;
    el.className = type === 'error' ? 'vc-status vc-status-error' : 'vc-status vc-status-success';
    el.style.display = 'block';
    clearTimeout(showStatus._timer);
    showStatus._timer = setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function updateLocalData(itemId, newData) {
    chrome.storage.local.get([itemId], (result) => {
        const currentData = result[itemId] || {};
        const updatedData = { ...currentData, ...newData };
        chrome.storage.local.set({ [itemId]: updatedData });
    });
}

async function sendReviewToServer(itemId, text, token, displayName = null) {
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
                // פתיחת טופס בחירת שם בתוך הפאנל במקום חלונית קופצת
                pendingReview = { itemId, text, token };
                document.getElementById('vc-name-form').style.display = 'block';
                document.getElementById('vc-display-name').focus();
            } else {
                showStatus(data.error || 'הפעולה נדחתה');
            }
        } else if (res.ok) {
            document.getElementById('new-review-text').value = '';
            document.getElementById('agree-rules').checked = false;
            showStatus('חוות הדעת פורסמה בהצלחה', 'success');
            await loadReviews(itemId);
        } else {
            const data = await res.json().catch(() => ({}));
            showStatus(data.error || 'שגיאה בשמירת הנתונים');
        }
    } catch (e) {
        console.error(e);
        showStatus('בעיה בחיבור לשרת. ייתכן שהשרת מתעורר - נסה שוב בעוד כחצי דקה.');
    }
}

async function loadReviews(itemId) {
    const list = document.getElementById('reviews-list');
    try {
        const res = await fetch(`${SERVER_URL}/api/reviews/${itemId}`);
        const reviews = await res.json();
        list.innerHTML = '';
        if (reviews.length === 0) {
            list.innerHTML = '<div style="color: #888;">אין עדיין דיווחים.</div>';
            return;
        }

        reviews.forEach(r => {
            let userClass = 'user-new'; 
            if (r.trustedUpvotes >= 5 && r.trustedUpvotes < 20) userClass = 'user-trusted';
            if (r.trustedUpvotes >= 20) userClass = 'user-expert';

            const div = document.createElement('div');
            div.className = 'review-item';
            div.innerHTML = `
                <div class="rev-meta">
                    <span class="${userClass}">${r.authorName}</span> 
                    <span class="rev-date">| ${r.timestamp}</span>
                </div>
                <div class="rev-text">${r.text}</div>
                <div class="rev-actions">
                    <button class="upvote-btn" data-id="${r.id}">👍 מועיל (${r.totalVotesOnReview})</button>
                </div>
            `;
            list.appendChild(div);
        });

        document.querySelectorAll('.upvote-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                const reviewId = this.getAttribute('data-id');
                upvoteReview(itemId, reviewId);
            });
        });

        list.scrollTop = list.scrollHeight;
    } catch (e) { 
        list.innerHTML = '<div style="color:red;">שגיאת רשת בטעינת נתונים ציבוריים. המידע האישי ממשיך לפעול.</div>'; 
    }
}

async function upvoteReview(itemId, reviewId) {
    chrome.runtime.sendMessage({ action: 'getAuthToken' }, async (response) => {
        if (!response || response.error || !response.token) {
            showStatus('חובה להתחבר עם חשבון גוגל כדי להצביע');
            return;
        }

        try {
            const res = await fetch(`${SERVER_URL}/api/reviews/${itemId}/${reviewId}/upvote`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${response.token}` }
            });

            if (res.ok) {
                showStatus('ההצבעה נקלטה, תודה!', 'success');
                loadReviews(itemId);
            } else {
                const data = await res.json().catch(() => ({}));
                showStatus(data.error || 'ההצבעה נכשלה');
            }
        } catch (e) {
            console.error(e);
            showStatus('בעיה בחיבור לשרת');
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