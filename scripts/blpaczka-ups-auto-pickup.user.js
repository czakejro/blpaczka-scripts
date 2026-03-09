// ==UserScript==
// @name         BLPaczka - UPS Auto Pickup (Zamawianie Podjazdu)
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Automatyzuje zamawianie kuriera UPS. Wykrywa UPS po nr listu (1Z...) LUB nazwie konta/cennika. Obsługuje NST, email nadawcy, wagę przesyłki. v2.2: +waga z sekcji "Cena przesyłki".
// @author       czax
// @match        *://*.blpaczka.com/admin/courier/orders/view/*
// @match        https://www.ups.com/ipr/schedule-pickup*
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

    const DATA_TIMEOUT_MS = 2 * 60 * 1000; // 2 minuty

    const DIACRITICS_MAP = {
        'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n', 'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
        'Ą': 'A', 'Ć': 'C', 'Ę': 'E', 'Ł': 'L', 'Ń': 'N', 'Ó': 'O', 'Ś': 'S', 'Ź': 'Z', 'Ż': 'Z'
    };

    function removeDiacritics(str) {
        if (!str) return '';
        return str.replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, match => DIACRITICS_MAP[match] || match);
    }

    // --- STYLE MODALA ---
    const modalStyle = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000;
        display: flex; justify-content: center; align-items: center; font-family: sans-serif;
    `;
    const boxStyle = `
        background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        text-align: center; max-width: 450px; width: 90%;
    `;
    const btnStyle = `
        display: block; width: 100%; margin: 8px 0; padding: 12px 20px; border: none; border-radius: 4px;
        cursor: pointer; font-weight: bold; font-size: 13px; text-align: left; white-space: pre-line;
    `;

    // ================= MODUŁ 1: BLPACZKA (Pobieranie danych) =================

    function initBLPaczka() {
        // --- DETEKCJA UPS ---
        let isUps = false;
        let waybillNumber = '';

        // Metoda 1: Sprawdź nr listu (zaczyna się od 1Z)
        const waybillElement = Array.from(document.querySelectorAll('td')).find(td => td.textContent.trim() === 'List przewozowy');
        if (waybillElement && waybillElement.nextElementSibling) {
            const txt = waybillElement.nextElementSibling.querySelector('strong')?.textContent.trim() || '';
            waybillNumber = txt;
            if (txt.startsWith('1Z')) {
                isUps = true;
            }
        }

        // Metoda 2: Sprawdź pole "Wysłano z konta"
        if (!isUps) {
            const accountLabelTd = Array.from(document.querySelectorAll('td')).find(td => td.textContent.trim() === 'Wysłano z konta');
            if (accountLabelTd && accountLabelTd.nextElementSibling) {
                const accountName = accountLabelTd.nextElementSibling.textContent.toUpperCase();
                if (accountName.includes('UPS')) {
                    isUps = true;
                }
            }
        }

        if (!isUps) return;

        // Znajdź miejsce na przycisk (Dane Nadawcy)
        const h2Sender = Array.from(document.querySelectorAll('h2')).find(h => h.textContent.trim().toLowerCase() === 'dane nadawcy');
        if (!h2Sender) return;

        // Stwórz przycisk
        const btn = document.createElement('button');
        btn.textContent = '🚚 Zamów podjazd UPS';
        btn.style.cssText = 'margin-left: 15px; padding: 5px 10px; background-color: #361505; color: #ffb500; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 12px; vertical-align: middle;';
        btn.title = "Otwiera stronę UPS i kopiuje dane (bez polskich znaków)";

        btn.onclick = (e) => {
            e.preventDefault();
            handlePickupClick(waybillNumber, h2Sender);
        };

        h2Sender.appendChild(btn);
    }

    // --- POBIERANIE DANYCH: Standardowy nadawca ---

    function getStandardSenderData(h2Element) {
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
            else if (label.includes('e-mail') || label.includes('email')) sender.email = val;
            else if (label.includes('adres')) {
                sender.city = (val.match(/Miasto.*?:\s*([^\n<]+)/i) || [])[1]?.trim();
                sender.postal = (val.match(/Kod Pocztowy.*?:\s*([^\n<]+)/i) || [])[1]?.trim();
                sender.street = (val.match(/Ulica.*?:\s*([^\n<]+)/i) || [])[1]?.replace(/\s+/g, ' ').trim();
            }
        });
        return sender;
    }

    // --- POBIERANIE DANYCH: Niestandardowy adres odbioru (NST) ---

    function getCustomPickupData() {
        const cells = Array.from(document.querySelectorAll('td'));
        const targetCell = cells.find(td => td.textContent.includes('Niestandardowy adres odbioru przesyłki'));

        if (!targetCell || !targetCell.nextElementSibling) return null;

        const dataCell = targetCell.nextElementSibling;
        const html = dataCell.innerHTML;

        const extract = (label) => {
            const regex = new RegExp(`${label}<\\/span>\\s*:\\s*([^<]+)`, 'i');
            const match = html.match(regex);
            return match ? match[1].trim() : '';
        };

        const customData = {
            name: extract('Nazwisko'),
            phone: extract('Telefon'),
            city: extract('Miasto'),
            postal: extract('Kod Pocztowy'),
            street: extract('Ulica'),
            company: '',
            email: '' // Zostanie uzupełniony z danych standardowego nadawcy
        };

        if (customData.street && customData.city) return customData;
        return null;
    }

    // --- POBIERANIE DANYCH: Waga przesyłki (z sekcji "Cena przesyłki") ---

    function getPackageWeight() {
        // Szukamy tekstu "Paczka nr 1Z..." w sekcji cenowej, waga jest w <b> obok
        const allTds = Array.from(document.querySelectorAll('td'));
        for (const td of allTds) {
            const text = td.textContent;
            if (text.includes('Paczka nr') && text.includes('1Z')) {
                const bold = td.querySelector('b');
                if (bold) {
                    // Format: "1 kg, 40 cm / 30 cm / 20 cm"
                    const weightMatch = bold.textContent.match(/([\d.,]+)\s*kg/i);
                    if (weightMatch) {
                        // Zwróć samą liczbę (np. "1" lub "2.5")
                        return weightMatch[1].replace(',', '.');
                    }
                }
            }
        }
        return '';
    }

    // --- LOGIKA WYBORU ADRESU ---

    function handlePickupClick(waybill, h2Sender) {
        const standardData = getStandardSenderData(h2Sender);
        const customData = getCustomPickupData();
        const weight = getPackageWeight();

        if (customData) {
            if (standardData.email) {
                customData.email = standardData.email;
            }

            showChoiceModal(waybill, standardData, customData, weight);
        } else {
            saveAndRedirect(waybill, standardData, weight);
        }
    }

    function showChoiceModal(waybill, standard, custom, weight) {
        const modal = document.createElement('div');
        modal.style.cssText = modalStyle;

        const box = document.createElement('div');
        box.style.cssText = boxStyle;
        box.innerHTML = `
            <h3 style="margin-top:0; color:#361505;">🚚 Wykryto niestandardowy adres odbioru</h3>
            <p style="color:#666; font-size:13px;">Którego adresu użyć do zamówienia kuriera UPS?</p>
        `;

        // Przycisk: Adres standardowy (nadawca)
        const btnStd = document.createElement('button');
        btnStd.textContent = `📍 Nadawca (Standard)\n${standard.street || '?'}, ${standard.postal || ''} ${standard.city || ''}`;
        btnStd.style.cssText = btnStyle + 'background-color: #6c757d; color: white;';
        btnStd.onclick = () => {
            saveAndRedirect(waybill, standard, weight);
            modal.remove();
        };

        // Przycisk: Adres niestandardowy
        const btnCust = document.createElement('button');
        btnCust.textContent = `📦 Niestandardowy adres odbioru\n${custom.street || '?'}, ${custom.postal || ''} ${custom.city || ''}`;
        btnCust.style.cssText = btnStyle + 'background-color: #361505; color: #ffb500;';
        btnCust.onclick = () => {
            saveAndRedirect(waybill, custom, weight);
            modal.remove();
        };

        // Przycisk: Anuluj
        const btnCancel = document.createElement('button');
        btnCancel.textContent = '✖ Anuluj';
        btnCancel.style.cssText = btnStyle + 'background-color: #f0f0f0; color: #333; font-size: 12px; text-align: center;';
        btnCancel.onclick = () => modal.remove();

        box.appendChild(btnCust);
        box.appendChild(btnStd);
        box.appendChild(btnCancel);
        modal.appendChild(box);
        document.body.appendChild(modal);

        // Zamknij klikając tło
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
    }

    function saveAndRedirect(waybill, rawData, weight) {
        const upsData = {
            tracking: waybill,
            company: removeDiacritics(rawData.name || ''),
            contact: removeDiacritics(rawData.company || ''),
            address: removeDiacritics(rawData.street || ''),
            postal: removeDiacritics(rawData.postal || ''),
            city: removeDiacritics(rawData.city || ''),
            phone: removeDiacritics(rawData.phone || ''),
            email: rawData.email || '',
            weight: weight || ''
        };

        GM_setValue('ups_autofill_data', JSON.stringify(upsData));
        GM_setValue('ups_autofill_timestamp', Date.now());

        GM_openInTab('https://www.ups.com/ipr/schedule-pickup?loc=pl_PL', { active: true });
    }

    // ================= MODUŁ 2: UPS (Wypełnianie formularza) =================

    async function initUPS() {
        const dataStr = GM_getValue('ups_autofill_data');
        const timestamp = GM_getValue('ups_autofill_timestamp');

        if (!dataStr || !timestamp || (Date.now() - timestamp > DATA_TIMEOUT_MS)) return;

        const data = JSON.parse(dataStr);
        GM_deleteValue('ups_autofill_data');
        GM_deleteValue('ups_autofill_timestamp');

        console.log("[BLPaczka UPS v2.2] Wypełniam formularz...", data);

        // Czekaj na element (Angular SPA)
        const waitFor = (selector, timeout = 15000) => new Promise((resolve, reject) => {
            const el = document.querySelector(selector);
            if (el) return resolve(el);
            const obs = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    obs.disconnect();
                    resolve(el);
                }
            });
            obs.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { obs.disconnect(); reject(new Error(`Timeout: ${selector}`)); }, timeout);
        });

        // Wypełnij pole (kompatybilne z Angular reactive forms)
        const fillField = (selector, value) => {
            const el = document.querySelector(selector);
            if (!el || !value) return false;

            el.focus();
            el.dispatchEvent(new Event('focus', { bubbles: true }));

            el.value = value;

            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));

            return true;
        };

        try {
            await waitFor('#inputZip');
            await new Promise(r => setTimeout(r, 800));

            // Zaznacz "Tak" przy etykietach (żeby pokazać pole trackingu)
            try {
                const yesRadio = document.querySelector('input[type="radio"][value="Y"]') ||
                                 document.querySelector('input[type="radio"][value="yes"]');
                if (yesRadio) {
                    yesRadio.click();
                    yesRadio.dispatchEvent(new Event('change', { bubbles: true }));
                    await new Promise(r => setTimeout(r, 500));
                }
            } catch (e) {}

            // Wypełnianie pól
            if (data.tracking) fillField('#usrInput', data.tracking);
            fillField('#inputCompanyOrName', data.company);
            fillField('#inputContact', data.contact);
            fillField('#inputAddressLine1', data.address);
            fillField('#inputCity', data.city);
            fillField('#inputZip', data.postal);
            fillField('#inputPhoneNo', data.phone);
            fillField('#inputEmail', data.email);
            if (data.weight) fillField('#inputWeight', data.weight);

            // Feedback sukces
            const feedback = document.createElement('div');
            feedback.innerHTML = '✅ <b>BLPaczka:</b> Dane UPS wklejone!';
            feedback.style.cssText = 'position:fixed; top:10px; right:10px; background:#361505; color:#ffb500; padding:15px 20px; border-radius:8px; z-index:99999; font-size:14px; box-shadow:0 4px 12px rgba(0,0,0,0.3); font-family:sans-serif;';
            document.body.appendChild(feedback);
            setTimeout(() => feedback.style.opacity = '0', 3000);
            setTimeout(() => feedback.remove(), 3500);

            console.log("[BLPaczka UPS v2.2] Formularz wypełniony!");

        } catch (err) {
            console.error("[BLPaczka UPS v2.2] Błąd:", err);

            const errDiv = document.createElement('div');
            errDiv.innerHTML = '⚠️ <b>BLPaczka:</b> Nie udało się wypełnić formularza. Sprawdź dane ręcznie.';
            errDiv.style.cssText = 'position:fixed; top:10px; right:10px; background:#dc3545; color:#fff; padding:15px 20px; border-radius:8px; z-index:99999; font-size:14px; box-shadow:0 4px 12px rgba(0,0,0,0.3); font-family:sans-serif;';
            document.body.appendChild(errDiv);
            setTimeout(() => errDiv.remove(), 5000);
        }
    }

    // ================= ROUTER =================

    if (window.location.hostname.includes('blpaczka.com')) {
        window.addEventListener('load', initBLPaczka);
        setTimeout(initBLPaczka, 1500);
    }
    else if (window.location.hostname.includes('ups.com')) {
        if (document.readyState === 'complete') {
            setTimeout(initUPS, 1500);
        } else {
            window.addEventListener('load', () => setTimeout(initUPS, 1500));
        }
    }

})();
