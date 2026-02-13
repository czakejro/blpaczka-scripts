// ==UserScript==
// @name         BLPaczka - DHL Auto Reklamacje
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Wypełnia formularz reklamacyjny DHL. Przycisk na panelu BLPaczka, auto-fill na dhl24.com.pl
// @author       Claude & Łukasz
// @match        *://*.blpaczka.com/admin/courier/orders/view/*
// @match        https://dhl24.com.pl/pl/claim/disposition/create.html*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ================= KONFIGURACJA =================
    const CONFIG = {
        dataExpiryMs: 10 * 60 * 1000,
        notificationDurationMs: 8000,
        btnClass: 'bl-dhl-complaint-btn',
        dhlUrl: 'https://dhl24.com.pl/pl/claim/disposition/create.html',
        storageData: 'dhl_complaint_data',
        storageTimestamp: 'dhl_complaint_timestamp',
    };

    const COMPANY = {
        name: 'BL Logistics sp. z.o.o.',
        email: 'reklamacje@blpaczka.com',
        phone: '564753193',
        bankAccount: '48 1140 1140 0000 3902 8700 1033',
    };

    const CLAIM_TYPES = {
        'ZAGINIECIE': { label: 'Zaginięcie przesyłki', value: 'ZAGINIECIE_PRZESYLKI' },
        'USZKODZENIE': { label: 'Uszkodzenie lub ubytek w przesyłce', value: 'USZKODZENIE_LUB_UBYTEK_W_PRZESYLCE' },
        'NIETERMINOWOSC': { label: 'Nieterminowość doręczenia', value: 'NIETERMINOWOSC_DORECZENIA' },
        'USTALENIE_LOSOW': { label: 'Ustalenie losów przesyłki', value: 'USTALENIE_LOSOW_PRZESYLKI' },
        'PROTOKOL_SZKODOWY': { label: 'Protokół szkodowy', value: 'PROTOKOL_SZKODOWY' },
    };

    // ================= UTILS =================

    function showNotification(message, type = 'success') {
        document.querySelectorAll('.bl-dhl-notification').forEach(el => el.remove());
        const colors = { success: '#FFCC00', error: '#dc3545', info: '#D40511', wait: '#0d6efd' };
        const textColors = { success: '#000', error: '#fff', info: '#fff', wait: '#fff' };
        const el = document.createElement('div');
        el.className = 'bl-dhl-notification';
        el.innerHTML = message;
        el.style.cssText = `position:fixed; bottom:20px; right:20px; background:${colors[type] || colors.info}; color:${textColors[type] || '#000'}; padding:15px 20px; border-radius:8px; z-index:99999; font-weight:bold; font-family:sans-serif; font-size:14px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: opacity 0.3s; max-width:420px; line-height:1.5;`;
        document.body.appendChild(el);
        if (type !== 'wait') {
            setTimeout(() => {
                el.style.opacity = '0';
                setTimeout(() => el.remove(), 300);
            }, CONFIG.notificationDurationMs);
        }
        return el;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function waitFor(selector, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(selector);
            if (existing) return resolve(existing);
            const timer = setTimeout(() => {
                obs.disconnect();
                reject(new Error(`Timeout: "${selector}" (${timeoutMs}ms)`));
            }, timeoutMs);
            const obs = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    clearTimeout(timer);
                    obs.disconnect();
                    resolve(el);
                }
            });
            obs.observe(document.body, { childList: true, subtree: true });
        });
    }

    function fillInput(id, value) {
        const el = document.getElementById(id);
        if (!el || !value) return false;
        if (el.value === value) return true;
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
    }

    function setSelect2(selectId, value, label) {
        const selectEl = document.getElementById(selectId);
        if (!selectEl) return false;
        try {
            if (window.jQuery && window.jQuery(selectEl).data('select2')) {
                window.jQuery(selectEl).val(value).trigger('change');
                console.log(`DHL: select2 jQuery — ${selectId} = ${value}`);
                return true;
            }
        } catch (e) {}

        selectEl.value = value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        const container = document.getElementById(`select2-${selectId}-container`);
        if (container && label) {
            container.textContent = label;
            container.setAttribute('title', label);
        }
        return true;
    }

    async function setSelect2WithClick(selectId, label) {
        const selectEl = document.getElementById(selectId);
        if (!selectEl) return false;
        const select2Container = selectEl.nextElementSibling;
        const selection = select2Container?.querySelector('.select2-selection');
        if (!selection) return false;

        selection.click();
        await sleep(400);

        const options = document.querySelectorAll('.select2-results__option');
        for (const opt of options) {
            if (opt.textContent.trim() === label) {
                opt.click();
                console.log(`DHL: klik — ${selectId} = ${label}`);
                return true;
            }
        }
        document.body.click();
        return false;
    }

    async function ensureSelect2(selectId, value, label) {
        // Zawsze próbuj kliknięcia jako pierwszą metodę — najniezawodniejsza z select2
        let ok = await setSelect2WithClick(selectId, label);
        if (!ok) {
            // Fallback: jQuery / natywne
            ok = setSelect2(selectId, value, label);
        }
        return ok;
    }

    function cleanupStorage() {
        GM_deleteValue(CONFIG.storageData);
        GM_deleteValue(CONFIG.storageTimestamp);
    }

    function findButtonByText(text) {
        const buttons = document.querySelectorAll('button, input[type="submit"], a.btn, .btn');
        for (const btn of buttons) {
            if (btn.textContent.trim().toLowerCase().includes(text.toLowerCase())) {
                // Sprawdź czy przycisk jest widoczny
                if (btn.offsetParent !== null || btn.offsetWidth > 0) {
                    return btn;
                }
            }
        }
        return null;
    }

    // ================= MODUŁ 1: BLPACZKA =================

    function getTrackingNumber() {
        const waybillTd = Array.from(document.querySelectorAll('td'))
            .find(td => td.textContent.trim() === 'List przewozowy');
        return {
            td: waybillTd,
            number: waybillTd?.nextElementSibling?.querySelector('strong')?.textContent.trim() || null
        };
    }

    function getAccountName() {
        const td = Array.from(document.querySelectorAll('td'))
            .find(td => td.textContent.trim() === 'Wysłano z konta');
        return td?.nextElementSibling?.textContent || '';
    }

    function showClaimTypeDialog(trackingNumber) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:99999; display:flex; align-items:center; justify-content:center;';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:#fff; border-radius:12px; padding:30px; min-width:400px; max-width:500px; box-shadow:0 8px 32px rgba(0,0,0,0.3); font-family:sans-serif;';

        const title = document.createElement('h3');
        title.textContent = `Reklamacja DHL: ${trackingNumber}`;
        title.style.cssText = 'margin:0 0 8px 0; color:#D40511; font-size:18px;';
        dialog.appendChild(title);

        const subtitle = document.createElement('p');
        subtitle.textContent = 'Wybierz rodzaj reklamacji:';
        subtitle.style.cssText = 'margin:0 0 20px 0; color:#666; font-size:14px;';
        dialog.appendChild(subtitle);

        return new Promise((resolve) => {
            Object.entries(CLAIM_TYPES).forEach(([key, claim]) => {
                const btn = document.createElement('button');
                btn.textContent = claim.label;
                btn.style.cssText = 'display:block; width:100%; padding:12px 16px; margin-bottom:8px; background:#f8f8f8; border:2px solid #ddd; border-radius:8px; cursor:pointer; font-size:14px; text-align:left; transition: all 0.15s;';
                btn.onmouseover = () => { btn.style.background = '#FFCC00'; btn.style.borderColor = '#D40511'; };
                btn.onmouseout = () => { btn.style.background = '#f8f8f8'; btn.style.borderColor = '#ddd'; };
                btn.onclick = () => { overlay.remove(); resolve(key); };
                dialog.appendChild(btn);
            });

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Anuluj';
            cancelBtn.style.cssText = 'display:block; width:100%; padding:10px 16px; margin-top:12px; background:transparent; border:1px solid #ccc; border-radius:8px; cursor:pointer; font-size:13px; color:#666;';
            cancelBtn.onclick = () => { overlay.remove(); resolve(null); };
            dialog.appendChild(cancelBtn);

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) { overlay.remove(); resolve(null); }
            });
        });
    }

    function initBLPaczka() {
        if (document.querySelector(`.${CONFIG.btnClass}`)) return;

        const { td: waybillTd, number: trackingNumber } = getTrackingNumber();
        if (!waybillTd || !trackingNumber) return;

        const accountName = getAccountName().toUpperCase();
        if (!accountName.includes('DHL')) return;

        const btn = document.createElement('button');
        btn.textContent = '📦 Złóż Reklamację DHL';
        btn.className = CONFIG.btnClass;
        btn.style.cssText = 'margin-left:10px; padding:3px 10px; background:#FFCC00; color:#000; border:2px solid #D40511; border-radius:4px; cursor:pointer; font-size:11px; font-weight:bold; vertical-align:middle;';

        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const claimTypeKey = await showClaimTypeDialog(trackingNumber);
            if (!claimTypeKey) return;

            GM_setValue(CONFIG.storageData, JSON.stringify({
                tracking: trackingNumber,
                claimType: claimTypeKey,
            }));
            GM_setValue(CONFIG.storageTimestamp, Date.now());
            GM_openInTab(CONFIG.dhlUrl, { active: true });
        });

        waybillTd.nextElementSibling.appendChild(btn);
    }

    // ================= MODUŁ 2: DHL24 (cały flow AJAX) =================

    async function initDHL() {
        let data;
        try {
            const dataStr = GM_getValue(CONFIG.storageData);
            const timestamp = GM_getValue(CONFIG.storageTimestamp);
            if (!dataStr || !timestamp) return;
            if (Date.now() - timestamp > CONFIG.dataExpiryMs) { cleanupStorage(); return; }
            data = JSON.parse(dataStr);
        } catch (err) {
            cleanupStorage();
            return;
        }

        if (!data.tracking || !data.claimType) { cleanupStorage(); return; }

        const claimInfo = CLAIM_TYPES[data.claimType];
        if (!claimInfo) { cleanupStorage(); return; }

        console.log('DHL AutoFill: start', data);

        // ======================
        // ETAP 1: Numer przesyłki
        // ======================
        try {
            await waitFor('#ClaimForm_shipmentNumber', 10000);
        } catch (err) {
            // Może jesteśmy już dalej — sprawdź etap 2 lub 3
            return tryLaterSteps(data, claimInfo);
        }

        fillInput('ClaimForm_shipmentNumber', data.tracking);

        showNotification(
            `📦 Numer <b>${data.tracking}</b> wpisany.<br>` +
            `Reklamacja: <b>${claimInfo.label}</b><br><br>` +
            `👆 Kliknij <b>Kontynuuj</b> (recaptcha).`,
            'wait'
        );

        // Czekaj aż dropdown rodzaju reklamacji pojawi się (user kliknie Kontynuuj)
        console.log('DHL: czekam na ClaimForm_type (max 3 min)...');
        try {
            await waitFor('#ClaimForm_type', 180000);
        } catch (err) {
            showNotification('Timeout — dropdown nie pojawił się.', 'error');
            cleanupStorage();
            return;
        }

        // ======================
        // ETAP 2: Rodzaj reklamacji
        // ======================
        document.querySelectorAll('.bl-dhl-notification').forEach(el => el.remove());
        showNotification(`Wybieram: <b>${claimInfo.label}</b>...`, 'info');

        await sleep(800);

        let selected = await ensureSelect2('ClaimForm_type', claimInfo.value, claimInfo.label);

        if (!selected) {
            showNotification(`⚠️ Nie udało się wybrać — wybierz ręcznie: <b>${claimInfo.label}</b>`, 'error');
            // Dalej czekamy na formularz danych
        }

        await sleep(500);

        // Kliknij Kontynuuj
        const continueBtn = findButtonByText('kontynuuj');
        if (continueBtn) {
            console.log('DHL: klikam Kontynuuj po wyborze rodzaju');
            continueBtn.click();
        } else {
            showNotification('Nie znalazłem Kontynuuj — kliknij ręcznie', 'error');
        }

        // ======================
        // ETAP 3: Formularz danych
        // ======================
        console.log('DHL: czekam na formularz danych (ClaimForm_IMIE_NAZWISKO)...');
        try {
            await waitFor('#ClaimForm_IMIE_NAZWISKO', 30000);
        } catch (err) {
            showNotification('Formularz danych nie pojawił się — odśwież stronę', 'error');
            cleanupStorage();
            return;
        }

        await sleep(800);
        await fillFormData(claimInfo);
    }

    async function tryLaterSteps(data, claimInfo) {
        // Sprawdź czy jesteśmy na etapie 2 (dropdown)
        if (document.getElementById('ClaimForm_type')) {
            showNotification(`Wybieram: <b>${claimInfo.label}</b>...`, 'info');
            await sleep(500);
            await ensureSelect2('ClaimForm_type', claimInfo.value, claimInfo.label);
            await sleep(500);
            const btn = findButtonByText('kontynuuj');
            if (btn) btn.click();

            try {
                await waitFor('#ClaimForm_IMIE_NAZWISKO', 30000);
                await sleep(800);
                await fillFormData(claimInfo);
            } catch (err) {
                showNotification('Formularz danych nie pojawił się', 'error');
                cleanupStorage();
            }
            return;
        }

        // Sprawdź czy jesteśmy na etapie 3 (formularz danych)
        if (document.getElementById('ClaimForm_IMIE_NAZWISKO')) {
            await sleep(500);
            await fillFormData(claimInfo);
            return;
        }

        showNotification('Nie rozpoznano etapu formularza DHL', 'error');
        cleanupStorage();
    }

    async function fillFormData(claimInfo) {
        document.querySelectorAll('.bl-dhl-notification').forEach(el => el.remove());
        showNotification('Wypełniam dane firmowe...', 'info');

        // Pola tekstowe (oprócz rachunku — ten po dropdownie)
        fillInput('ClaimForm_IMIE_NAZWISKO', COMPANY.name);
        fillInput('ClaimForm_EMAIL', COMPANY.email);
        fillInput('ClaimForm_TELEFON', COMPANY.phone);

        // Dropdowny select2 — z krótkim delay między każdym
        await sleep(400);
        await ensureSelect2('ClaimForm_ZGLASZAJACY', 'ZLECENIODAWCA', 'Zleceniodawca');
        await sleep(400);
        await ensureSelect2('ClaimForm_WYBOR_WALUTY', 'PLN', 'PLN');
        await sleep(400);
        await ensureSelect2('ClaimForm_OCZEKIWANA_FORMA_WYPLATY_ODSZKODOWANIA', 'PRZELEW_BANKOWY', 'Przelew bankowy');
        await sleep(400);

        // Zagraniczny rachunek → Nie (musi być PRZED wpisaniem rachunku!)
        await ensureSelect2('ClaimForm_CZY_RACHUNEK_ZAGRANICZNY', 'NIE', 'Nie');

        // Czekaj aż pole rachunku bankowego będzie dostępne/widoczne
        await sleep(800);
        try {
            await waitFor('#ClaimForm_RACHUNEK_BANKOWY', 5000);
        } catch (e) {
            console.warn('DHL: pole rachunku bankowego nie pojawiło się');
        }
        fillInput('ClaimForm_RACHUNEK_BANKOWY', COMPANY.bankAccount);

        await sleep(400);
        await ensureSelect2('ClaimForm_STATUS', 'TAK', 'Tak');

        await sleep(300);

        showNotification(
            `✅ Dane wypełnione!<br>` +
            `Uzupełnij ręcznie: <b>Opis zdarzenia</b>, <b>Kwotę roszczenia</b>,<br>` +
            `załączniki, i kliknij <b>Wyślij</b>.`,
            'success'
        );

        cleanupStorage();
        console.log('DHL AutoFill: gotowe!');
    }

    // ================= ROUTER =================
    const host = window.location.hostname;

    if (host.includes('blpaczka.com')) {
        if (document.readyState === 'complete') {
            initBLPaczka();
        } else {
            window.addEventListener('load', initBLPaczka);
        }
        setTimeout(initBLPaczka, 2500);
    }
    else if (host.includes('dhl24.com.pl')) {
        initDHL();
    }
})();
