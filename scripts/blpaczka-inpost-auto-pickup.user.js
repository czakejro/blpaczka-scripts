// ==UserScript==
// @name         BLPaczka - InPost Auto Pickup (v2.9 - Custom Pickup Email Fix)
// @namespace    http://tampermonkey.net/
// @version      2.9
// @description  Automatyzuje zamawianie InPost. Obsługuje wybór adresu. E-mail zawsze pobierany z głównego Nadawcy.
// @author       Gemini & User
// @match        *://*.blpaczka.com/admin/courier/orders/view/*
// @match        https://kurier.inpost.pl/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ================= KONFIGURACJA =================
    const DATA_TIMEOUT_MS = 10 * 60 * 1000;

    // --- STYLE MODALA ---
    const modalStyle = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000;
        display: flex; justify-content: center; align-items: center; font-family: sans-serif;
    `;
    const boxStyle = `
        background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        text-align: center; max-width: 400px; width: 90%;
    `;
    const btnStyle = `
        margin: 10px; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; color: white;
    `;

    // ================= MODUŁ 1: BLPACZKA =================

    function initBLPaczka() {
        // --- DETEKCJA INPOST (Ignoruj FedEx) ---
        let isInPost = false;
        const accountLabelTd = Array.from(document.querySelectorAll('td')).find(td => td.textContent.trim() === 'Wysłano z konta');

        if (accountLabelTd && accountLabelTd.nextElementSibling) {
            const accountName = accountLabelTd.nextElementSibling.textContent.toUpperCase();
            if (accountName.includes('FEDEX')) return; // Stop dla FedEx
            if (accountName.includes('INPOST') || accountName.includes('PACZKOMAT')) isInPost = true;
        }
        if (!isInPost) return;

        const h2Sender = Array.from(document.querySelectorAll('h2')).find(h => h.textContent.trim().toLowerCase() === 'dane nadawcy');
        if (!h2Sender) return;

        const btn = document.createElement('button');
        btn.textContent = '📦 Zamów InPost';
        btn.style.cssText = 'margin-left: 15px; padding: 5px 10px; background-color: #ffcc00; color: #000; border: 1px solid #e6b800; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 12px; vertical-align: middle;';

        btn.onclick = (e) => {
            e.preventDefault();
            handlePickupClick(h2Sender);
        };
        h2Sender.appendChild(btn);
    }

    // --- LOGIKA POBIERANIA DANYCH ---

    // 1. Pobieranie standardowego Nadawcy (z tabeli)
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
            else if (label.includes('e-mail')) sender.email = val;
            else if (label.includes('adres')) {
                sender.city = (val.match(/Miasto.*?:\s*([^\n<]+)/i) || [])[1]?.trim();
                sender.postal = (val.match(/Kod Pocztowy.*?:\s*([^\n<]+)/i) || [])[1]?.trim();
                sender.street = (val.match(/Ulica.*?:\s*([^\n<]+)/i) || [])[1]?.replace(/\s+/g, ' ').trim();
            }
        });
        return sender;
    }

    // 2. Pobieranie Niestandardowego Adresu (z "Zamawianie kuriera")
    function getCustomPickupData() {
        // Szukamy tabeli, która zawiera tekst "Niestandardowy adres odbioru przesyłki"
        const cells = Array.from(document.querySelectorAll('td'));
        const targetCell = cells.find(td => td.textContent.includes('Niestandardowy adres odbioru przesyłki'));

        if (!targetCell || !targetCell.nextElementSibling) return null;

        const dataCell = targetCell.nextElementSibling;
        const html = dataCell.innerHTML; // Pobieramy HTML, bo tam są <br> i <span>

        const extract = (label) => {
            const regex = new RegExp(`${label}<\\/span>\\s*:\\s*([^<]+)`, 'i');
            const match = html.match(regex);
            return match ? match[1].trim() : '';
        };

        const customData = {
            name: extract('Nazwisko'), // W InPost to pole "Imię i nazwisko" lub "Firma"
            phone: extract('Telefon'),
            city: extract('Miasto'),
            postal: extract('Kod Pocztowy'),
            street: extract('Ulica'),
            // Email zostanie uzupełniony z danych nadawcy w funkcji handlePickupClick
            company: ''
        };

        if (customData.street && customData.city) return customData;
        return null;
    }

    // --- LOGIKA WYBORU ---

    function handlePickupClick(h2Sender) {
        const standardData = getStandardSenderData(h2Sender);
        const customData = getCustomPickupData();

        if (customData) {
            // FIX: Przypisz e-mail Nadawcy do danych Niestandardowych
            // (bo niestandardowy adres zazwyczaj nie ma pola email w widoku BL)
            if (standardData.email) {
                customData.email = standardData.email;
            }

            // Jeśli jest niestandardowy adres -> Pytamy użytkownika
            showChoiceModal(standardData, customData);
        } else {
            // Jeśli nie ma -> Używamy standardowego
            saveAndRedirect(standardData);
        }
    }

    function showChoiceModal(standard, custom) {
        const modal = document.createElement('div');
        modal.style.cssText = modalStyle;

        const box = document.createElement('div');
        box.style.cssText = boxStyle;
        box.innerHTML = `<h3>Wykryto niestandardowy adres odbioru</h3><p>Którego adresu użyć do zamówienia kuriera?</p>`;

        // Przycisk Standardowy
        const btnStd = document.createElement('button');
        btnStd.textContent = `Nadawca (Standard)\n${standard.city}, ${standard.street}`;
        btnStd.style.cssText = btnStyle + 'background-color: #6c757d;'; // Szary
        btnStd.onclick = () => {
            saveAndRedirect(standard);
            modal.remove();
        };

        // Przycisk Niestandardowy
        const btnCust = document.createElement('button');
        btnCust.innerText = `Niestandardowy\n${custom.city}, ${custom.street}`;
        btnCust.style.cssText = btnStyle + 'background-color: #ffcc00; color: black; border: 1px solid #e6b800;'; // InPost Żółty
        btnCust.onclick = () => {
            saveAndRedirect(custom);
            modal.remove();
        };

        box.appendChild(btnStd);
        box.appendChild(btnCust);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    function saveAndRedirect(rawData) {
        // Logika wyboru nazwy firmy (Firma lub Imię Nazwisko jeśli brak firmy)
        let finalCompany = rawData.company;
        if (!finalCompany || finalCompany.trim() === '') {
            finalCompany = rawData.name;
        }

        const inpostData = {
            company_field: finalCompany || '',
            contact_person: rawData.name || '',
            address: rawData.street || '',
            postal: rawData.postal || '',
            city: rawData.city || '',
            phone: rawData.phone || '',
            email: rawData.email || ''
        };

        GM_setValue('inpost_autofill_data', JSON.stringify(inpostData));
        GM_setValue('inpost_autofill_timestamp', Date.now());

        GM_openInTab('https://kurier.inpost.pl/NewPickup.aspx', { active: true });
    }

    // ================= MODUŁ 2: INPOST =================

    async function initInPost() {
        const dataStr = GM_getValue('inpost_autofill_data');
        const timestamp = GM_getValue('inpost_autofill_timestamp');

        if (!dataStr || !timestamp || (Date.now() - timestamp > DATA_TIMEOUT_MS)) return;

        const currentUrl = window.location.href.toLowerCase();

        // 1. Logowanie
        if (currentUrl.includes('logon.aspx') || document.querySelector('input[type="password"]')) {
            const info = document.createElement('div');
            info.innerHTML = '⚠️ <b>Dane czekają...</b> Zaloguj się.';
            info.style.cssText = 'position:fixed; top:10px; right:10px; background:#ffcc00; color:#000; padding:10px; border-radius:5px; z-index:9999; border: 2px solid #000; font-family:sans-serif;';
            document.body.appendChild(info);
            return;
        }

        // 2. Formularz
        if (currentUrl.includes('newpickup.aspx')) {
            const data = JSON.parse(dataStr);
            GM_deleteValue('inpost_autofill_data');

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

            // Kliknij "Zmień"
            const findChangeButton = () => {
                const spans = Array.from(document.querySelectorAll('span.dx-vam'));
                return spans.find(s => s.textContent.trim() === 'Zmień');
            };

            const changeBtn = await new Promise(resolve => {
                const check = () => {
                    const btn = findChangeButton();
                    if (btn) resolve(btn); else setTimeout(check, 200);
                };
                check();
            });

            if (changeBtn) {
                changeBtn.click();
                await new Promise(r => setTimeout(r, 1000));
            }

            await waitFor('#ctl00_ContentPlaceHolder1_NewPickupControl_Company1_Panel1_txbName_I');

            const fill = (id, val) => {
                const el = document.getElementById(id);
                if (el) {
                    el.value = val;
                    el.dispatchEvent(new Event('focus'));
                    el.dispatchEvent(new Event('input'));
                    el.dispatchEvent(new Event('change'));
                    el.dispatchEvent(new Event('blur'));
                }
            };

            fill('ctl00_ContentPlaceHolder1_NewPickupControl_Company1_Panel1_txbName_I', data.company_field);
            fill('ctl00_ContentPlaceHolder1_NewPickupControl_Company1_Panel1_pnlAddressPL_txbAddress_I', data.address);
            fill('ctl00_ContentPlaceHolder1_NewPickupControl_Company1_Panel1_txbPostCode_I', data.postal);
            fill('ctl00_ContentPlaceHolder1_NewPickupControl_Company1_Panel1_txbCity_I', data.city);
            fill('ctl00_ContentPlaceHolder1_NewPickupControl_Company1_Panel1_txbSurname_I', data.contact_person);
            fill('ctl00_ContentPlaceHolder1_NewPickupControl_Company1_Panel1_txbPhone_I', data.phone);
            fill('ctl00_ContentPlaceHolder1_NewPickupControl_Company1_Panel1_txbEmail_I', data.email);

            const feedback = document.createElement('div');
            feedback.textContent = '✅ Formularz InPost wypełniony!';
            feedback.style.cssText = 'position:fixed; top:10px; right:10px; background:#28a745; color:#fff; padding:15px; border-radius:5px; z-index:9999; font-weight:bold; font-family:sans-serif;';
            document.body.appendChild(feedback);
            setTimeout(() => feedback.remove(), 4000);
        }
    }

    // ================= ROUTER =================

    if (window.location.hostname.includes('blpaczka.com')) {
        window.addEventListener('load', initBLPaczka);
        setTimeout(initBLPaczka, 1500);
    }
    else if (window.location.hostname.includes('inpost.pl')) {
        initInPost();
    }

})();