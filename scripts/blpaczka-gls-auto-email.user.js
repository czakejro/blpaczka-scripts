// ==UserScript==
// @name         BLPaczka - GLS Auto Email (Freshdesk) v1.2
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Szybkie zamawianie GLS przez Freshdesk + Auto uzupełnianie pól (Grupa, Typ, Przewoźnik).
// @author       czax
// @match        *://*.blpaczka.com/admin/courier/orders/view/*
// @match        https://blpaczka.freshdesk.com/a/tickets/compose-email*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ================= KONFIGURACJA =================
    const GLS_EMAIL_RECIPIENT = 'dok.warszawa@gls-poland.com';

    // Konfiguracja pól do wyboru (Label: "Wartość do kliknięcia")
    // Upewnij się, że nazwy kluczy (np. 'Grupa') dokładnie odpowiadają nazwom widocznym na ekranie w Freshdesk
    const DROPDOWN_CONFIG = [
        { label: 'Grupa', value: 'Info' },
        { label: 'Typ', value: 'Brak podjazdu kuriera' },
        { label: 'Przewoźnik', value: 'GLS' }
    ];

    // ================= NARZĘDZIA =================

    // Szybki waitFor
    const waitFor = (selector, parent = document) => new Promise(resolve => {
        const el = parent.querySelector(selector);
        if (el) return resolve(el);
        const interval = setInterval(() => {
            const found = parent.querySelector(selector);
            if (found) {
                clearInterval(interval);
                resolve(found);
            }
        }, 50);
    });

    // Funkcja obsługująca dropdowny Freshdesk (Ember Power Select)
    async function selectFreshdeskDropdown(labelText, optionText) {
        // 1. Znajdź etykietę (Label)
        const allLabels = Array.from(document.querySelectorAll('label, .f-label, span.label-text'));
        const targetLabel = allLabels.find(l => l.textContent.trim().includes(labelText));

        if (!targetLabel) {
            console.warn(`Nie znaleziono etykiety pola: ${labelText}`);
            return;
        }

        // 2. Znajdź trigger (klikacz) w kontenerze rodzica
        // Szukamy w górę drzewa kontenera, który obejmuje label i dropdown
        let container = targetLabel.closest('.ember-view');
        if (!container) container = targetLabel.parentElement.parentElement;

        const trigger = container ? container.querySelector('.ember-power-select-trigger') : null;

        if (trigger) {
            // Przewiń do elementu, żeby był widoczny (dla stabilności)
            trigger.scrollIntoView({ block: 'center', behavior: 'instant' });

            // Kliknij, aby otworzyć listę
            trigger.click();

            // 3. Czekaj na pojawienie się opcji (są renderowane w body)
            await waitFor('.ember-power-select-options');

            // Małe opóźnienie dla renderowania tekstu
            await new Promise(r => setTimeout(r, 100));

            // 4. Znajdź właściwą opcję i kliknij
            const options = Array.from(document.querySelectorAll('.ember-power-select-option'));
            const targetOption = options.find(o => o.textContent.trim() === optionText);

            if (targetOption) {
                targetOption.click();
                console.log(`✅ Wybrano ${labelText}: ${optionText}`);
            } else {
                console.warn(`Nie znaleziono opcji "${optionText}" dla pola "${labelText}"`);
                // Kliknij trigger ponownie żeby zamknąć, jeśli nie znaleziono
                trigger.click();
            }

            // Odczekaj chwilę po kliknięciu, aby UI się zamknęło
            await new Promise(r => setTimeout(r, 200));
        } else {
            console.warn(`Nie znaleziono listy rozwijanej dla: ${labelText}`);
        }
    }

    function cleanPhoneNumber(phone) {
        if (!phone) return '';
        let cleaned = phone.replace(/\D/g, '');
        cleaned = cleaned.replace(/^0+/, '');
        if (cleaned.length === 11 && cleaned.startsWith('48')) cleaned = cleaned.substring(2);
        return cleaned;
    }

    // ================= CZĘŚĆ 1: BLPACZKA =================

    function initBLPaczka() {
        const accountLabelTd = Array.from(document.querySelectorAll('td')).find(td => td.textContent.trim() === 'Wysłano z konta');
        if (!accountLabelTd || !accountLabelTd.nextElementSibling) return;
        if (!accountLabelTd.nextElementSibling.textContent.toUpperCase().includes('GLS')) return;

        const h2Sender = Array.from(document.querySelectorAll('h2')).find(h => h.textContent.trim().toLowerCase() === 'dane nadawcy');
        const targetElement = h2Sender || document.querySelector('h2');
        if (!targetElement) return;

        const btn = document.createElement('button');
        btn.textContent = '🔵 Zamów GLS (Email)';
        btn.style.cssText = 'margin-left: 15px; padding: 6px 12px; background-color: #0047bb; color: #fff; border: 2px solid #ffb500; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 12px; vertical-align: middle;';

        btn.onclick = (e) => {
            e.preventDefault();
            handlePickupClick();
        };
        targetElement.appendChild(btn);
    }

    function getTrackingNumber() {
        const glsLink = document.querySelector('a[href*="gls-group.com"]');
        if (glsLink) return glsLink.textContent.trim();

        const tds = Array.from(document.querySelectorAll('td'));
        const trackingLabel = tds.find(td => td.textContent.includes('Numer listu') || td.textContent.includes('Numer przesyłki'));
        if (trackingLabel && trackingLabel.nextElementSibling) {
            return trackingLabel.nextElementSibling.textContent.trim();
        }
        return 'BRAK_NUMERU';
    }

    function getTableData(headerText) {
        const allHeaders = Array.from(document.querySelectorAll('h2'));
        const targetHeader = allHeaders.find(h => h.textContent.trim().toLowerCase().includes(headerText.toLowerCase()));
        if (!targetHeader) return {};
        let nextElem = targetHeader.nextElementSibling;
        while (nextElem) {
            if (nextElem.tagName === 'TABLE') return extractDataFromTable(nextElem);
            nextElem = nextElem.nextElementSibling;
        }
        return {};
    }

    function extractDataFromTable(table) {
        const data = {};
        if (!table) return data;
        table.querySelectorAll('tr').forEach(tr => {
            const tds = tr.querySelectorAll('td');
            if (tds.length < 2) return;
            const label = tds[0].textContent.trim().toLowerCase();
            const val = tds[1].textContent.trim();

            if (label.includes('imię')) data.name = val;
            else if (label.includes('firma')) data.company = val;
            else if (label.includes('telefon')) data.phone = val;
            else if (label.includes('e-mail') || label.includes('email')) data.email = val;
            else if (label.includes('adres')) {
                data.city = (val.match(/Miasto.*?:\s*([^\n<]+)/i) || [])[1]?.trim();
                data.postal = (val.match(/Kod Pocztowy.*?:\s*([^\n<]+)/i) || [])[1]?.trim();
                data.street = (val.match(/Ulica.*?:\s*([^\n<]+)/i) || [])[1]?.replace(/\s+/g, ' ').trim();
            }
        });
        return data;
    }

    function getCustomPickupData() {
        const cells = Array.from(document.querySelectorAll('td'));
        const targetCell = cells.find(td => td.textContent.includes('Niestandardowy adres odbioru przesyłki'));
        if (!targetCell || !targetCell.nextElementSibling) return null;

        const html = targetCell.nextElementSibling.innerHTML;
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
            company: ''
        };
        return (customData.street && customData.city) ? customData : null;
    }

    function handlePickupClick() {
        const sender = getTableData('dane nadawcy');
        const customPickup = getCustomPickupData();
        const trackingNumber = getTrackingNumber();

        if (customPickup && sender.email) customPickup.email = sender.email;
        const rawData = { sender, customPickup, trackingNumber };

        if (customPickup) {
            showChoiceModal(rawData);
        } else {
            saveAndRedirect(rawData.sender, rawData.trackingNumber);
        }
    }

    function showChoiceModal(rawData) {
        const modal = document.createElement('div');
        modal.style.cssText = `position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; display: flex; justify-content: center; align-items: center; font-family: sans-serif;`;

        const box = document.createElement('div');
        box.style.cssText = `background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); text-align: center; max-width: 400px; width: 90%;`;
        box.innerHTML = `<h3>GLS: Wykryto niestandardowy adres odbioru</h3><p>Które dane wkleić do maila?</p>`;

        const btnStyle = `margin: 10px; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; color: white;`;

        const btnStd = document.createElement('button');
        btnStd.textContent = `Nadawca (Standard)\n${rawData.sender.city}`;
        btnStd.style.cssText = btnStyle + 'background-color: #6c757d;';
        btnStd.onclick = () => {
            saveAndRedirect(rawData.sender, rawData.trackingNumber);
            modal.remove();
        };

        const btnCust = document.createElement('button');
        btnCust.innerText = `Niestandardowy\n${rawData.customPickup.city}`;
        btnCust.style.cssText = btnStyle + 'background-color: #0047bb; border: 1px solid #ffb500;';
        btnCust.onclick = () => {
            saveAndRedirect(rawData.customPickup, rawData.trackingNumber);
            modal.remove();
        };

        box.appendChild(btnStd);
        box.appendChild(btnCust);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    function saveAndRedirect(addressData, trackingNumber) {
        let finalCompany = addressData.company;
        if (!finalCompany || finalCompany.trim().length < 2) finalCompany = addressData.name;
        let finalContact = addressData.name;
        if (!finalContact || finalContact === finalCompany) finalContact = "Pracownik";

        const glsData = {
            company: finalCompany || '',
            contact: finalContact || '',
            address: addressData.street || '',
            postal: addressData.postal || '',
            city: addressData.city || '',
            phone: cleanPhoneNumber(addressData.phone),
            trackingNumber: trackingNumber || 'BRAK_NUMERU'
        };

        GM_setValue('gls_freshdesk_data', JSON.stringify(glsData));
        GM_openInTab('https://blpaczka.freshdesk.com/a/tickets/compose-email', { active: true });
    }

    // ================= CZĘŚĆ 2: FRESHDESK =================

    async function initFreshdesk() {
        const dataStr = GM_getValue('gls_freshdesk_data');
        if (!dataStr) return;

        const data = JSON.parse(dataStr);
        console.log("GLS Freshdesk Script: Start", data);

        // --- 1. EMAIL ---
        const toInput = await waitFor('.ember-power-select-search-input');
        toInput.focus();
        toInput.value = GLS_EMAIL_RECIPIENT;
        toInput.dispatchEvent(new Event('input', { bubbles: true }));
        toInput.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        toInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));

        // --- 2. TEMAT ---
        const subjectInput = await waitFor('input[name="subject"]');
        subjectInput.value = `Podjazd kuriera dla ${data.trackingNumber}`;
        subjectInput.dispatchEvent(new Event('input', { bubbles: true }));
        subjectInput.dispatchEvent(new Event('change', { bubbles: true }));

        // --- 3. TREŚĆ ---
        const editor = await waitFor('div[contenteditable="true"][aria-label*="Body"], .redactor-editor, div[contenteditable="true"]');
        const bodyHTML = `
            <div style="font-family: Arial, sans-serif; font-size: 14px; color: #222;">
                Dzień dobry, proszę o odbiór przesyłki <b>${data.trackingNumber}</b> od:<br><br>
                <b>${data.company}</b><br>
                ${data.address}<br>
                ${data.postal} ${data.city}<br><br>
                Osoba kontaktowa: ${data.contact}<br>
                Tel: ${data.phone}<br><br>
                Proszę o udostępnienie nr telefonu do kierowcy jeśli jest taka możliwość.<br><br>
            </div>
        `;
        editor.focus();
        editor.insertAdjacentHTML('afterbegin', bodyHTML);

        // --- 4. DROPDOWNY (Grupa, Typ, Przewoźnik) ---
        // Czekamy chwilę aż pola boczne się wyrenderują (czasami ładują się wolniej niż edytor)
        await new Promise(r => setTimeout(r, 500));

        for (const field of DROPDOWN_CONFIG) {
            await selectFreshdeskDropdown(field.label, field.value);
        }

        // --- 5. FINISH ---
        GM_deleteValue('gls_freshdesk_data');
        const info = document.createElement('div');
        info.innerHTML = `✅ GLS Gotowe!<br>Mail + Pola ustawione.`;
        info.style.cssText = 'position:fixed; bottom:10px; right:10px; background:#28a745; color:#fff; padding:10px; border-radius:5px; z-index:9999; font-weight:bold; font-size:12px; font-family:sans-serif;';
        document.body.appendChild(info);
        setTimeout(() => info.remove(), 4000);
    }

    // ================= ROUTER =================
    if (window.location.hostname.includes('blpaczka.com')) {
        if (document.readyState === 'complete') initBLPaczka();
        else window.addEventListener('load', initBLPaczka);
    }
    else if (window.location.hostname.includes('freshdesk.com')) {
        initFreshdesk();
    }

})();