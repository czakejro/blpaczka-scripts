// ==UserScript==
// @name         BLPaczka - UPS Auto Pickup (Zamawianie Podjazdu)
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Automatyzuje zamawianie kuriera UPS. Wykrywa UPS po nr listu (1Z...) LUB nazwie konta/cennika. Usuwa polskie znaki i wypełnia formularz.
// @author       czax
// @match        *://*.blpaczka.com/admin/courier/orders/view/*
// @match        https://wwwapps.ups.com/pickup/schedule*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ================= KONFIGURACJA =================

    // Mapa zamiany polskich znaków
    const DIACRITICS_MAP = {
        'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n', 'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
        'Ą': 'A', 'Ć': 'C', 'Ę': 'E', 'Ł': 'L', 'Ń': 'N', 'Ó': 'O', 'Ś': 'S', 'Ź': 'Z', 'Ż': 'Z'
    };

    function removeDiacritics(str) {
        if (!str) return '';
        return str.replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, match => DIACRITICS_MAP[match] || match);
    }

    // ================= MODUŁ 1: BLPACZKA (Pobieranie danych) =================

    function initBLPaczka() {
        // --- DETEKCJA UPS ---
        let isUps = false;
        let waybillNumber = '';

        // Metoda 1: Sprawdź nr listu (zaczyna się od 1Z)
        const waybillElement = Array.from(document.querySelectorAll('td')).find(td => td.textContent.trim() === 'List przewozowy');
        if (waybillElement && waybillElement.nextElementSibling) {
            const txt = waybillElement.nextElementSibling.querySelector('strong')?.textContent.trim() || '';
            waybillNumber = txt; // Zapisujemy nr listu, przyda się do formularza
            if (txt.startsWith('1Z')) {
                isUps = true;
            }
        }

        // Metoda 2: Sprawdź pole "Wysłano z konta" (Na podstawie Twojego screena)
        if (!isUps) {
            const accountLabelTd = Array.from(document.querySelectorAll('td')).find(td => td.textContent.trim() === 'Wysłano z konta');
            if (accountLabelTd && accountLabelTd.nextElementSibling) {
                const accountName = accountLabelTd.nextElementSibling.textContent.toUpperCase();
                // Sprawdzamy czy nazwa konta/cennika zawiera "UPS"
                if (accountName.includes('UPS')) {
                    isUps = true;
                }
            }
        }

        // Jeśli to nie jest UPS (ani wg listu, ani wg cennika), kończymy działanie
        if (!isUps) return;


        // 2. Znajdź miejsce na przycisk (Dane Nadawcy)
        const h2Sender = Array.from(document.querySelectorAll('h2')).find(h => h.textContent.trim().toLowerCase() === 'dane nadawcy');
        if (!h2Sender) return;

        // 3. Stwórz przycisk
        const btn = document.createElement('button');
        btn.textContent = '🚚 Zamów podjazd UPS';
        btn.style.cssText = 'margin-left: 15px; padding: 5px 10px; background-color: #361505; color: #ffb500; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 12px; vertical-align: middle;';
        btn.title = "Otwiera stronę UPS i kopiuje dane (bez polskich znaków)";

        btn.onclick = (e) => {
            e.preventDefault();
            // Przekazujemy waybillNumber - jeśli go nie ma (bo wykryto po cenniku, a listu brak), wyśle pusty string, co jest OK.
            processAndOpenUPS(waybillNumber, h2Sender);
        };

        h2Sender.appendChild(btn);
    }

    function getSenderData(h2Element) {
        let table = h2Element.nextElementSibling;
        while (table && table.tagName !== 'TABLE') table = table.nextElementSibling;
        if (!table) return {};

        const sender = {};
        table.querySelectorAll('tr').forEach(tr => {
            const tds = tr.querySelectorAll('td');
            if (tds.length < 2) return;
            const label = tds[0].textContent.trim().toLowerCase();
            const val = tds[1].textContent.trim();

            if (label.includes('imię')) sender.name = val;
            else if (label.includes('firma')) sender.company = val;
            else if (label.includes('telefon')) sender.phone = val;
            else if (label.includes('adres')) {
                sender.city = (val.match(/Miasto.*?:\s*([^\n<]+)/i) || [])[1]?.trim();
                sender.postal = (val.match(/Kod Pocztowy.*?:\s*([^\n<]+)/i) || [])[1]?.trim();
                sender.street = (val.match(/Ulica.*?:\s*([^\n<]+)/i) || [])[1]?.replace(/\s+/g, ' ').trim();
            }
        });
        return sender;
    }

    function processAndOpenUPS(waybill, h2Element) {
        const rawData = getSenderData(h2Element);

        const upsData = {
            tracking: waybill,
            field_company: removeDiacritics(rawData.name || ''),
            field_custname: removeDiacritics(rawData.company || ''),
            address: removeDiacritics(rawData.street || ''),
            postal: removeDiacritics(rawData.postal || ''),
            city: removeDiacritics(rawData.city || ''),
            phone: removeDiacritics(rawData.phone || '')
        };

        GM_setValue('ups_autofill_data', JSON.stringify(upsData));
        GM_setValue('ups_autofill_timestamp', Date.now());
        GM_openInTab('https://wwwapps.ups.com/pickup/schedule?loc=pl_PL', { active: true });
    }

    // ================= MODUŁ 2: UPS (Wypełnianie formularza) =================

    async function initUPS() {
        const dataStr = GM_getValue('ups_autofill_data');
        const timestamp = GM_getValue('ups_autofill_timestamp');

        if (!dataStr || !timestamp || (Date.now() - timestamp > 60000)) return;

        const data = JSON.parse(dataStr);
        GM_deleteValue('ups_autofill_data');

        console.log("BLPaczka Script: Wypełniam UPS...", data);

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

        // 1. Zaznacz "Tak" przy etykietach (żeby pokazać pole trackingu)
        try {
            const yesRadio = document.querySelector('input[type="radio"][value="Y"]') ||
                             document.querySelector('input[type="radio"][value="yes"]');
            if (yesRadio) {
                yesRadio.click();
                yesRadio.dispatchEvent(new Event('change', { bubbles: true }));
                await new Promise(r => setTimeout(r, 500));
            }
        } catch (e) {}

        const fillField = (selector, value) => {
            const el = document.querySelector(selector);
            if (el && value) {
                el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
            }
        };

        await waitFor('#postalcode');

        // -- WYPEŁNIANIE --
        if (data.tracking) fillField('#trkNbrAreaId', data.tracking);
        fillField('#addrMDCompanyId', data.field_company);
        fillField('#addrMDCustNameId', data.field_custname);
        fillField('#addressId', data.address);
        fillField('#postalcode', data.postal);
        fillField('#pd2Id', data.city);
        fillField('#addrMDPhoneId', data.phone);

        // Feedback
        const feedback = document.createElement('div');
        feedback.textContent = '📋 Dane UPS wklejone!';
        feedback.style.cssText = 'position:fixed; top:10px; right:10px; background:#28a745; color:#fff; padding:15px; border-radius:5px; z-index:9999; font-weight:bold; box-shadow:0 2px 5px rgba(0,0,0,0.3);';
        document.body.appendChild(feedback);
        setTimeout(() => feedback.remove(), 4000);
    }

    // ================= ROUTER =================

    if (window.location.hostname.includes('blpaczka.com')) {
        window.addEventListener('load', initBLPaczka);
        setTimeout(initBLPaczka, 1500);
    }
    else if (window.location.hostname.includes('ups.com')) {
        initUPS();
    }

})();