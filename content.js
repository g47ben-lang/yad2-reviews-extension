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

let feedScanInterval;

// מטמון לתוצאות batch-check כדי לא להציף את השרת בסריקות חוזרות
let lastBatchSignature = '';
let lastBatchResult = {};
let lastBatchTime = 0;

function init() {
    clearInterval(feedScanInterval); 
    const url = window.location.href;
    
    if (url.includes('/item/')) {
        setTimeout(injectItemPage, 1000);
        setTimeout(injectItemPage, 2500);
    } else if (url.includes('/vehicles/')) {
        injectFeedPage();
        feedScanInterval = setInterval(injectFeedPage, 2000);
    }
}

// עדכון חי של הסמלים בפיד במקרה של שינוי מטאב אחר
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && window.location.href.includes('/vehicles/')) {
        injectFeedPage(); 
    }
});

async function injectFeedPage() {
    // איתור רחב יותר של קישורי מודעות
    const itemLinks = document.querySelectorAll('a[href*="/item/"]');
    const itemsData = {};

    // שמירת מערך של קישורים עבור כל ID, לתמיכה במודעות כפולות
    itemLinks.forEach(link => {
        const match = link.href.match(/item\/([a-zA-Z0-9\-]+)/);
        if (match) {
            const id = match[1];
            if (!itemsData[id]) itemsData[id] = [];
            itemsData[id].push(link);
        }
    });

    const itemIds = Object.keys(itemsData);
    if (itemIds.length === 0) return;

    console.log(`[בקרת רכבים] נמצאו ${itemIds.length} מזהים ייחודיים בפיד.`);

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
        itemIds.forEach(id => {
            itemsData[id].forEach(linkEl => {
                
                // הסרת סמלים ישנים
                const existingBadge = linkEl.querySelector('.v-badge-container');
                if (existingBadge) existingBadge.remove();

                const badgeContainer = document.createElement('div');
                badgeContainer.className = 'v-badge-container';
                // עיצוב שדורס כל חסימת overflow או z-index של יד 2
                badgeContainer.style.cssText = 'position: absolute !important; top: 8px !important; right: 8px !important; z-index: 2147483647 !important; display: flex !important; flex-direction: column !important; gap: 6px !important; pointer-events: none !important;';
                
                let hasPublic = publicReviews[id];
                let privateNote = localData[id]?.note;
                let status = localData[id]?.status;

                linkEl.style.opacity = '1';

                if (status === 'irrelevant') {
                    linkEl.style.opacity = '0.3';
                    badgeContainer.innerHTML += '<span style="background:#dc3545 !important; color:#fff !important; padding:4px 8px !important; border-radius:4px !important; font-weight:bold !important; font-size:13px !important; box-shadow:0 2px 6px rgba(0,0,0,0.6) !important; border: 1px solid white !important;">🚫 לא רלוונטי</span>';
                } else {
                    if (status === 'interesting') {
                        badgeContainer.innerHTML += '<span style="background:#28a745 !important; color:#fff !important; padding:4px 8px !important; border-radius:4px !important; font-weight:bold !important; font-size:13px !important; box-shadow:0 2px 6px rgba(0,0,0,0.6) !important; border: 1px solid white !important;">⭐ מעניין</span>';
                    }
                    if (hasPublic) {
                        badgeContainer.innerHTML += '<span style="background:#ff7100 !important; color:#fff !important; padding:4px 8px !important; border-radius:4px !important; font-weight:bold !important; font-size:13px !important; box-shadow:0 2px 6px rgba(0,0,0,0.6) !important; border: 1px solid white !important;">🌍 חוות דעת</span>';
                    }
                    if (privateNote && privateNote.trim() !== '') {
                        badgeContainer.innerHTML += '<span style="background:#6c757d !important; color:#fff !important; padding:4px 8px !important; border-radius:4px !important; font-weight:bold !important; font-size:13px !important; box-shadow:0 2px 6px rgba(0,0,0,0.6) !important; border: 1px solid white !important;">🔒 הערה אישית</span>';
                    }
                }

                if (badgeContainer.innerHTML !== '') {
                    linkEl.style.setProperty('position', 'relative', 'important');
                    linkEl.style.setProperty('display', 'block', 'important');
                    linkEl.appendChild(badgeContainer);
                }
            });
        });
    });
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
        if(text.trim() === "") return;
        if (!document.getElementById('agree-rules').checked) return alert('יש לאשר את הכללים.');

        chrome.runtime.sendMessage({ action: 'getAuthToken' }, async (response) => {
            if (!response || response.error || !response.token) return alert('חובה להתחבר עם גוגל.');
            await sendReviewToServer(itemId, text, response.token);
        });
    });
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
            const data = await res.json();
            if (data.error === 'require_username') {
                const name = prompt("התחברות ראשונה: בחר שם תצוגה מקצועי למערכת:");
                if (name && name.trim() !== '') {
                    return sendReviewToServer(itemId, text, token, name);
                } else {
                    alert("חובה לבחור שם תצוגה כדי לכתוב בקהילה.");
                }
            }
        } else if (res.ok) {
            document.getElementById('new-review-text').value = '';
            document.getElementById('agree-rules').checked = false;
            await loadReviews(itemId);
        } else {
            alert('שגיאה בשמירת הנתונים.');
        }
    } catch (e) {
        console.error(e);
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
            alert('חובה להתחבר כדי להצביע.');
            return;
        }
        
        try {
            const res = await fetch(`${SERVER_URL}/api/reviews/${itemId}/${reviewId}/upvote`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${response.token}` }
            });
            
            if (res.status === 403) {
                const data = await res.json();
                alert(data.error); 
            } else if (res.ok) {
                loadReviews(itemId);
            }
        } catch (e) {
            console.error(e);
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