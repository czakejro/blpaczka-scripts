// ==UserScript==
// @name         BLPaczka - InPost Auto Reklamacje
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Wypełnia formularz reklamacyjny InPost. Ignoruje przesyłki FedEx.
// @author       Gemini & User & Claude
// @match        *://*.blpaczka.com/admin/courier/orders/view/*
// @match        https://inpost.pl/reklamacje/*
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
        // Dane firmy
        email: 'reklamacje@blpaczka.com',
        companyName: 'BL Logistics sp. z.o.o.',
        userType: 'Payer', // Płatnik
        accountNumber: '48 1140 1140 0000 3902 8700 1033',
        street: 'Czerska',
        houseNumber: '8/10',
        postCode: '00-732',
        city: 'Warszawa',

        // Timeouty i limity
        dataExpiryMs: 5 * 60 * 1000,  // 5 minut ważności danych
        fillIntervalMs: 500,            // co ile ms próbować wypełniać
        maxBasicAttempts: 15,            // max prób dla pól podstawowych
        maxFinanceAttempts: 15,          // max prób dla pól finansowych
        notificationDurationMs: 5000,    // jak długo widoczne powiadomienie

        // Selektory przycisków
        btnClass: 'bl-inpost-complaint-btn',
    };

    const INPOST_URLS = {
        home: 'https://inpost.pl/reklamacje/przesylka-nadana-do-domu',
        locker: 'https://inpost.pl/reklamacje/przesylka-nadana-do-paczkomatu',
    };

    // ================= UTILS =================

    function showNotification(message, type = 'success') {
        const colors = {
            success: '#28a745',
            error: '#dc3545',
            info: '#17a2b8',
        };
        const el = document.createElement('div');
        el.textContent = message;
        el.style.cssText = `position:fixed; bottom:20px; right:20px; background:${colors[type] || colors.info}; color:#fff; padding:15px 20px; border-radius:8px; z-index:99999; font-weight:bold; font-family:sans-serif; font-size:14px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: opacity 0.3s;`;
        document.body.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 300);
        }, CONFIG.notificationDurationMs);
    }

    function waitFor(selector, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(selector);
            if (existing) return resolve(existing);

            const timer = setTimeout(() => {
                obs.disconnect();
                reject(new Error(`Timeout: nie znaleziono "${selector}" w ${timeoutMs}ms`));
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

    function fillField(selector, value) {
        const el = document.querySelector(selector);
        if (!el) return false;

        if (el.type === 'checkbox' || el.type === 'radio') {
            if (!el.checked) {
                el.click();
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } else {
            if (el.value === String(value)) return true; // już wypełnione
            el.focus();
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
        }
        return true;
    }

    function cleanupStorage() {
        GM_deleteValue('inpost_complaint_data');
        GM_deleteValue('inpost_complaint_timestamp');
    }

    // ================= MODUŁ 1: BLPACZKA =================

    function findOldestShipmentDate() {
        const dates = [];
        document.querySelectorAll('tr').forEach(row => {
            if (!row.textContent.includes('STATUS_COLLECTED')) return;
            const cells = row.querySelectorAll('td');
            if (cells.length === 0) return;
            const dateMatch = cells[cells.length - 1].textContent.trim().match(/^(\d{4}-\d{2}-\d{2})/);
            if (dateMatch) dates.push(dateMatch[1]);
        });
        dates.sort();
        return dates[0] || null;
    }

    function getAccountName() {
        const accountLabelTd = Array.from(document.querySelectorAll('td'))
            .find(td => td.textContent.trim() === 'Wysłano z konta');
        return accountLabelTd?.nextElementSibling?.textContent || '';
    }

    function getTrackingNumber() {
        const waybillTd = Array.from(document.querySelectorAll('td'))
            .find(td => td.textContent.trim() === 'List przewozowy');
        return {
            td: waybillTd,
            number: waybillTd?.nextElementSibling?.querySelector('strong')?.textContent.trim() || null
        };
    }

    function determineInPostUrl(trackingNumber, accountName) {
        const accountLower = accountName.toLowerCase();

        if (trackingNumber.startsWith('5')) {
            return INPOST_URLS.home;
        }

        if (trackingNumber.startsWith('6')) {
            const isToDoor = ['to_door', 'do domu', 'do drzwi'].some(kw => accountLower.includes(kw));
            return isToDoor ? INPOST_URLS.home : INPOST_URLS.locker;
        }

        return null;
    }

    function initBLPaczka() {
        // Guard: zapobiegaj podwójnemu przyciskowi
        if (document.querySelector(`.${CONFIG.btnClass}`)) return;

        const { td: waybillTd, number: trackingNumber } = getTrackingNumber();
        if (!waybillTd || !trackingNumber) return;

        // Sprawdź czy FedEx
        const accountName = getAccountName();
        if (accountName.toUpperCase().includes('FEDEX')) return;

        // Tylko InPost (numery zaczynające się na 5 lub 6)
        if (!trackingNumber.startsWith('5') && !trackingNumber.startsWith('6')) return;

        const targetUrl = determineInPostUrl(trackingNumber, accountName);
        if (!targetUrl) return;

        // Tworzenie przycisku
        const btn = document.createElement('button');
        btn.textContent = '⚠️ Złóż Reklamację InPost';
        btn.className = CONFIG.btnClass;
        btn.style.cssText = 'margin-left:10px; padding:3px 10px; background:#dc3545; color:#fff; border:1px solid #b02a37; border-radius:4px; cursor:pointer; font-size:11px; vertical-align:middle;';

        btn.addEventListener('click', (e) => {
            e.preventDefault();

            let shipmentDate = findOldestShipmentDate();
            if (!shipmentDate) {
                shipmentDate = new Date().toISOString().split('T')[0];
                alert('Brak STATUS_COLLECTED w historii. Ustawiam dzisiejszą datę nadania.');
            }

            try {
                GM_setValue('inpost_complaint_data', JSON.stringify({
                    tracking: trackingNumber,
                    shipDate: shipmentDate
                }));
                GM_setValue('inpost_complaint_timestamp', Date.now());
                GM_openInTab(targetUrl, { active: true });
            } catch (err) {
                alert('Błąd zapisu danych: ' + err.message);
            }
        });

        waybillTd.nextElementSibling.appendChild(btn);
    }

    // ================= MODUŁ 2: INPOST =================

    async function initInPost() {
        // Odczyt i walidacja danych
        let data;
        try {
            const dataStr = GM_getValue('inpost_complaint_data');
            const timestamp = GM_getValue('inpost_complaint_timestamp');

            if (!dataStr || !timestamp) return;

            if (Date.now() - timestamp > CONFIG.dataExpiryMs) {
                console.log('InPost AutoFill: dane wygasły, czyszczę storage');
                cleanupStorage();
                return;
            }

            data = JSON.parse(dataStr);
        } catch (err) {
            console.error('InPost AutoFill: błąd odczytu danych', err);
            cleanupStorage();
            return;
        }

        if (!data.tracking) {
            console.error('InPost AutoFill: brak numeru przesyłki');
            cleanupStorage();
            return;
        }

        console.log('InPost AutoFill: Start', data);

        // --- ETAP 1: Pola podstawowe ---
        try {
            await waitFor('#edit-tracking-no');
        } catch (err) {
            showNotification('Nie znaleziono formularza InPost', 'error');
            cleanupStorage();
            return;
        }

        const basicFields = {
            '#edit-type': CONFIG.userType,
            '#edit-e-mail': CONFIG.email,
            '#edit-tracking-no': data.tracking,
            '#edit-date': data.shipDate,
        };

        const companySelectors = ['#edit-name', '#edit-company-name', 'input[name="company_name"]'];

        await new Promise(resolve => {
            let attempts = 0;
            const interval = setInterval(() => {
                attempts++;

                let allFilled = true;
                for (const [sel, val] of Object.entries(basicFields)) {
                    if (val && !fillField(sel, val)) allFilled = false;
                }

                // Nazwa firmy — próbuj różne selektory
                const companyFilled = companySelectors.some(sel => fillField(sel, CONFIG.companyName));
                if (!companyFilled) allFilled = false;

                if (allFilled || attempts >= CONFIG.maxBasicAttempts) {
                    clearInterval(interval);
                    resolve();
                }
            }, CONFIG.fillIntervalMs);
        });

        // --- ETAP 2: Roszczenie finansowe ---
        const claimSelect = document.querySelector('#edit-financial-claim');
        if (claimSelect) {
            claimSelect.value = '1'; // Tak
            claimSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // --- ETAP 3: Pola finansowe i adresowe ---
        try {
            await waitFor('#edit-street');
        } catch (err) {
            showNotification('Pola adresowe nie pojawiły się — uzupełnij ręcznie', 'error');
            cleanupStorage();
            return;
        }

        const financeFields = {
            '#edit-street': CONFIG.street,
            '#edit-house-number': CONFIG.houseNumber,
            '#edit-post-code': CONFIG.postCode,
            '#edit-town': CONFIG.city,
            '#edit-bank-account': CONFIG.accountNumber,
        };

        await new Promise(resolve => {
            let attempts = 0;
            const interval = setInterval(() => {
                attempts++;

                let allFilled = true;
                for (const [sel, val] of Object.entries(financeFields)) {
                    if (!fillField(sel, val)) allFilled = false;
                }

                // Checkboxy / radio
                const foreignCb = document.querySelector('input[name="foreign_bank_account"]');
                if (foreignCb && foreignCb.checked) foreignCb.click();

                const vatYes = document.querySelector('input[name="vat_payer"][value="1"]') || document.querySelector('#edit-vat-payer-yes');
                if (vatYes && !vatYes.checked) vatYes.click();

                const insurerNo = document.querySelector('input[name="insurer"][value="0"]') || document.querySelector('#edit-insurer-no');
                if (insurerNo && !insurerNo.checked) insurerNo.click();

                fillField('#edit-confirm-correctness', true);

                if (allFilled || attempts >= CONFIG.maxFinanceAttempts) {
                    clearInterval(interval);
                    resolve();
                }
            }, CONFIG.fillIntervalMs);
        });

        // Sukces
        showNotification(`✅ Formularz wypełniony: ${data.tracking}`);
        cleanupStorage();
        console.log('InPost AutoFill: zakończono pomyślnie');
    }

    // ================= ROUTER =================
    const host = window.location.hostname;

    if (host.includes('blpaczka.com')) {
        // Jeden listener + fallback z guardami — bez ryzyka duplikacji
        if (document.readyState === 'complete') {
            initBLPaczka();
        } else {
            window.addEventListener('load', initBLPaczka);
        }
        // Fallback dla dynamicznie ładowanych treści
        setTimeout(initBLPaczka, 2500);
    }
    else if (host.includes('inpost.pl')) {
        initInPost();
    }
})();
