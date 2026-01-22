// ==UserScript==
// @name         BLPaczka - InPost Auto Reklamacje (Fix FedEx Conflict)
// @namespace    http://tampermonkey.net/
// @version      2.7
// @description  Wypełnia formularz reklamacyjny InPost. Ignoruje przesyłki FedEx.
// @author       Gemini & User
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

    // ================= KONFIGURACJA DANYCH STAŁYCH =================
    const FIXED_DATA = {
        email: 'reklamacje@blpaczka.com',
        companyName: 'BL Logistics sp. z.o.o.',
        userType: 'Payer', // Płatnik
        accountNumber: '39 1140 1140 0000 3902 8700 1001',
        street: 'Czerska',
        houseNumber: '8/7',
        postCode: '00-732',
        city: 'Warszawa'
    };

    // ================= MODUŁ 1: BLPACZKA =================

    function findOldestShipmentDate() {
        const allRows = document.querySelectorAll('tr');
        const dates = [];
        allRows.forEach(row => {
            if (row.textContent.includes('STATUS_COLLECTED')) {
                const cells = row.querySelectorAll('td');
                if (cells.length > 0) {
                    const dateCell = cells[cells.length - 1];
                    const dateText = dateCell.textContent.trim();
                    const dateMatch = dateText.match(/^(\d{4}-\d{2}-\d{2})/);
                    if (dateMatch) dates.push(dateMatch[1]);
                }
            }
        });
        if (dates.length === 0) return null;
        dates.sort();
        return dates[0];
    }

    function initBLPaczka() {
        const waybillTd = Array.from(document.querySelectorAll('td')).find(td => td.textContent.trim() === 'List przewozowy');
        if (!waybillTd || !waybillTd.nextElementSibling) return;

        const trackingNumber = waybillTd.nextElementSibling.querySelector('strong')?.textContent.trim();
        if (!trackingNumber) return;

        // --- NOWA LOGIKA WYKLUCZANIA FEDEX ---
        // Sprawdzamy pole "Wysłano z konta"
        const accountLabelTd = Array.from(document.querySelectorAll('td')).find(td => td.textContent.trim() === 'Wysłano z konta');
        let isFedEx = false;

        if (accountLabelTd && accountLabelTd.nextElementSibling) {
            const accountName = accountLabelTd.nextElementSibling.textContent.toUpperCase();
            if (accountName.includes('FEDEX')) {
                isFedEx = true;
            }
        }

        // Jeśli to FedEx, przerywamy (nawet jak numer zaczyna się na 6)
        if (isFedEx) return;

        // --- DALSZA LOGIKA INPOST ---
        if (!trackingNumber.startsWith('5') && !trackingNumber.startsWith('6')) return;

        let targetUrl = '';
        const urlToHome = 'https://inpost.pl/reklamacje/przesylka-nadana-do-domu';
        const urlToLocker = 'https://inpost.pl/reklamacje/przesylka-nadana-do-paczkomatu';

        if (trackingNumber.startsWith('5')) {
            targetUrl = urlToHome;
        }
        else if (trackingNumber.startsWith('6')) {
            let isToDoor = false;
            if (accountLabelTd && accountLabelTd.nextElementSibling) {
                const accountName = accountLabelTd.nextElementSibling.textContent.toLowerCase();
                if (accountName.includes('to_door') || accountName.includes('do domu') || accountName.includes('do drzwi')) {
                    isToDoor = true;
                }
            }
            targetUrl = isToDoor ? urlToHome : urlToLocker;
        }

        if (!targetUrl) return;

        const btn = document.createElement('button');
        btn.textContent = '⚠️ Złóż Reklamację';
        btn.style.cssText = 'margin-left: 10px; padding: 2px 8px; background-color: #dc3545; color: #fff; border: 1px solid #b02a37; border-radius: 4px; cursor: pointer; font-size: 11px; vertical-align: middle;';

        btn.onclick = (e) => {
            e.preventDefault();
            let shipmentDate = findOldestShipmentDate();
            if (!shipmentDate) {
                shipmentDate = new Date().toISOString().split('T')[0];
                alert('Brak STATUS_COLLECTED. Ustawiam dzisiejszą datę.');
            }
            const complaintData = { tracking: trackingNumber, shipDate: shipmentDate };
            GM_setValue('inpost_complaint_data', JSON.stringify(complaintData));
            GM_setValue('inpost_complaint_timestamp', Date.now());
            GM_openInTab(targetUrl, { active: true });
        };
        waybillTd.nextElementSibling.appendChild(btn);
    }

    // ================= MODUŁ 2: INPOST =================

    async function initInPost() {
        const dataStr = GM_getValue('inpost_complaint_data');
        const timestamp = GM_getValue('inpost_complaint_timestamp');

        if (!dataStr || !timestamp || (Date.now() - timestamp > 5 * 60 * 1000)) return;

        const data = JSON.parse(dataStr);
        console.log('InPost AutoFill: Start', data);

        const waitFor = (selector) => new Promise(resolve => {
            if (document.querySelector(selector)) return resolve(document.querySelector(selector));
            const obs = new MutationObserver(() => {
                if (document.querySelector(selector)) {
                    obs.disconnect();
                    resolve(document.querySelector(selector));
                }
            });
            obs.observe(document.body, { childList: true, subtree: true });
        });

        const fillField = (selector, value) => {
            const el = document.querySelector(selector);
            if (el) {
                if (el.type === 'checkbox' || el.type === 'radio') {
                    if (!el.checked) {
                        el.click();
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                } else {
                    el.value = value;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                }
                return true;
            }
            return false;
        };

        // --- ETAP 1: Podstawy ---
        await waitFor('#edit-tracking-no');

        let attempts = 0;
        const mainInterval = setInterval(() => {
            attempts++;
            if (attempts > 8) clearInterval(mainInterval);

            fillField('#edit-type', FIXED_DATA.userType);
            fillField('#edit-e-mail', FIXED_DATA.email);
            fillField('#edit-tracking-no', data.tracking);
            if (data.shipDate) fillField('#edit-date', data.shipDate);

            if (!fillField('#edit-name', FIXED_DATA.companyName)) {
                if (!fillField('#edit-company-name', FIXED_DATA.companyName)) {
                    fillField('input[name="company_name"]', FIXED_DATA.companyName);
                }
            }
        }, 500);

        // --- ETAP 2: Wybór Roszczenia Finansowego ---
        const claimSelect = document.querySelector('#edit-financial-claim');
        if (claimSelect) {
            claimSelect.value = '1'; // Tak
            claimSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }

        console.log('Wybrano roszczenie finansowe, czekam na pola...');
        await waitFor('#edit-street');

        // --- ETAP 3: Finanse i Adres ---
        let financeAttempts = 0;
        const financeInterval = setInterval(() => {
            financeAttempts++;
            if (financeAttempts > 10) clearInterval(financeInterval);

            fillField('#edit-street', FIXED_DATA.street);
            fillField('#edit-house-number', FIXED_DATA.houseNumber);
            fillField('#edit-post-code', FIXED_DATA.postCode);
            fillField('#edit-town', FIXED_DATA.city);
            fillField('#edit-bank-account', FIXED_DATA.accountNumber);

            const foreignCheckbox = document.querySelector('input[name="foreign_bank_account"]');
            if (foreignCheckbox && foreignCheckbox.checked) foreignCheckbox.click();

            const vatYes = document.querySelector('input[name="vat_payer"][value="1"]') || document.querySelector('#edit-vat-payer-yes');
            if (vatYes && !vatYes.checked) vatYes.click();

            const insurerNo = document.querySelector('input[name="insurer"][value="0"]') || document.querySelector('#edit-insurer-no');
            if (insurerNo && !insurerNo.checked) insurerNo.click();

            fillField('#edit-confirm-correctness', true);

        }, 500);

        const info = document.createElement('div');
        info.innerHTML = `✅ Wypełnianie: Rachunek Bankowy, Adres...`;
        info.style.cssText = 'position:fixed; bottom:20px; right:20px; background:#28a745; color:#fff; padding:15px; border-radius:5px; z-index:9999; font-weight:bold; font-family:sans-serif;';
        document.body.appendChild(info);

        GM_deleteValue('inpost_complaint_data');
    }

    // ================= ROUTER =================
    if (window.location.hostname.includes('blpaczka.com')) {
        window.addEventListener('load', initBLPaczka);
        setTimeout(initBLPaczka, 2000);
    }
    else if (window.location.hostname.includes('inpost.pl')) {
        initInPost();
    }
})();