// ==UserScript==
// @name         BLPaczka - Poczta Polska (E-nadawca) v1.9
// @namespace    http://tampermonkey.net/
// @version      1.9
// @description  Full Auto: Dane (Firma+Nazwisko+Email) -> Logowanie -> Szukaj -> Wynik -> Zamów Kuriera -> Wypełnij Formularz + PNA.
// @author       Gemini & User
// @match        *://*.blpaczka.com/admin/courier/orders/view/*
// @match        https://e-nadawca.poczta-polska.pl/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ================= HELPERY =================
    function cleanPhoneNumber(phone) {
        if (!phone) return '';
        let cleaned = phone.replace(/\D/g, '');
        cleaned = cleaned.replace(/^0+/, '');
        if (cleaned.length === 11 && cleaned.startsWith('48')) cleaned = cleaned.substring(2);
        return cleaned;
    }

    function parseStreet(fullStreet) {
        if (!fullStreet) return { street: '', houseNo: '', localNo: '' };
        const match = fullStreet.match(/^(.+?)\s+(\d+[a-zA-Z]*)(.*)$/);
        if (match) {
            return {
                street: match[1].trim(),
                houseNo: match[2].trim(),
                localNo: match[3].replace(/[()/]/g, '').trim()
            };
        }
        return { street: fullStreet, houseNo: '', localNo: '' };
    }

    function simulateInput(element, value) {
        if (!element) return;
        element.value = value;
        element.dispatchEvent(new Event('focus', { bubbles: true }));
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    // Style UI
    const modalStyle = `position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; display: flex; justify-content: center; align-items: center; font-family: sans-serif;`;
    const boxStyle = `background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); text-align: center; max-width: 400px; width: 90%;`;
    const btnStyle = `margin: 10px; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; color: white;`;

    // ================= CZĘŚĆ 1: BLPACZKA =================

    function initBLPaczka() {
        const accountLabelTd = Array.from(document.querySelectorAll('td')).find(td => td.textContent.trim() === 'Wysłano z konta');
        if (!accountLabelTd || !accountLabelTd.nextElementSibling) return;
        const courierName = accountLabelTd.nextElementSibling.textContent.trim().toLowerCase();

        if (!courierName.includes('poczta polska') && !courierName.includes('pocztex')) return;

        const h2Sender = Array.from(document.querySelectorAll('h2')).find(h => h.textContent.trim().toLowerCase().includes('nadawc'));
        const targetElement = h2Sender || document.querySelector('h2');

        if (targetElement) {
            const btn = document.createElement('button');
            btn.textContent = '🔴 Zamów Pocztex (E-nadawca)';
            btn.style.cssText = 'margin-left: 15px; padding: 6px 12px; background-color: #d40000; color: #fff; border: 2px solid #ffcc00; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 12px; vertical-align: middle;';
            btn.onclick = (e) => { e.preventDefault(); handleExport(); };
            targetElement.appendChild(btn);
        }
    }

    // --- Pobieranie danych ---

    function getTrackingNumber() {
        const bodyText = document.body.innerText;
        const match = bodyText.match(/(PX\d+)/);
        if (match) return match[1];
        const tds = Array.from(document.querySelectorAll('td'));
        const trackingTd = tds.find(td => td.textContent.includes('PX'));
        return trackingTd ? trackingTd.textContent.trim().split(' ')[0] : 'BRAK';
    }

    function getPackageData() {
        const contentBox = document.getElementById('content') || document.body;
        const htmlContent = contentBox.innerHTML;
        const weightMatch = htmlContent.match(/(\d+(?:[.,]\d+)?)\s*kg/i);
        let weight = '1';
        if(weightMatch) weight = weightMatch[1].replace(',', '.');
        return { weight };
    }

    function getTableData(headerText) {
        const allHeaders = Array.from(document.querySelectorAll('h2'));
        const targetHeader = allHeaders.find(h => h.textContent.trim().toLowerCase().includes(headerText.toLowerCase()));
        if (!targetHeader) return {}; // Zwracamy pusty obiekt zamiast null dla bezpieczeństwa
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
            if (label.includes('imię') || label.includes('nadawca')) data.name = val;
            else if (label.includes('firma')) data.company = val;
            else if (label.includes('telefon')) data.phone = val;
            else if (label.includes('e-mail') || label.includes('email')) data.email = val;
            else if (label.includes('adres')) {
                data.city = (val.match(/Miasto.*?:\s*([^\n<]+)/i) || [])[1]?.trim();
                data.postal = (val.match(/Kod Pocztowy.*?:\s*([^\n<]+)/i) || [])[1]?.trim();
                data.street = (val.match(/Ulica.*?:\s*([^\n<]+)/i) || [])[1]?.replace(/\s+/g, ' ').trim();
            }
        });
        const addressParts = parseStreet(data.street || '');
        return {
            name: data.name || '',
            company: data.company || '',
            phone: cleanPhoneNumber(data.phone),
            email: data.email || '',
            city: data.city,
            postal: data.postal,
            street: addressParts.street,
            houseNo: addressParts.houseNo,
            localNo: addressParts.localNo
        };
    }

    function getCustomPickupData() {
        const cells = Array.from(document.querySelectorAll('td'));
        const targetCell = cells.find(td => td.textContent.includes('Niestandardowy adres odbioru przesyłki'));
        if (!targetCell || !targetCell.nextElementSibling) return null;
        const html = targetCell.nextElementSibling.innerHTML;

        const getText = (label) => {
            const regex = new RegExp(`${label}.*?:\\s*([^<]+)`, 'i');
            const match = html.match(regex);
            if (!match) {
                 const regexSimple = new RegExp(`${label}\\s*:\\s*([^\\n<]+)`);
                 const matchSimple = html.match(regexSimple);
                 return matchSimple ? matchSimple[1].trim() : '';
            }
            return match[1].trim();
        };

        const rawName = getText('Nazwisko');
        const rawCompany = getText('Firma');
        const rawStreet = getText('Ulica');
        const addressParts = parseStreet(rawStreet);

        if (!rawStreet && !getText('Miasto')) return null;

        return {
            name: rawName,
            company: rawCompany,
            phone: cleanPhoneNumber(getText('Telefon')),
            email: getText('Email') || getText('E-mail') || '', // Próba pobrania maila z customa
            city: getText('Miasto'),
            postal: getText('Kod Pocztowy'),
            street: addressParts.street,
            houseNo: addressParts.houseNo,
            localNo: addressParts.localNo
        };
    }

    function handleExport() {
        const senderData = getTableData('dane nadawcy'); // Zawsze pobieramy, żeby mieć email
        const customData = getCustomPickupData();
        const tracking = getTrackingNumber();
        const packageInfo = getPackageData();

        const extraData = { weight: packageInfo.weight };

        // FIX: Jeśli w customData brakuje maila, bierzemy go z senderData
        if (customData && !customData.email && senderData.email) {
            customData.email = senderData.email;
        }

        if (customData) showChoiceModal(senderData, customData, tracking, extraData);
        else if (senderData.street) saveAndRedirect(senderData, tracking, extraData);
        else alert('Błąd: Nie znaleziono adresu Nadawcy.');
    }

    function showChoiceModal(senderData, customData, tracking, extraData) {
        const modal = document.createElement('div');
        modal.style.cssText = modalStyle;
        const box = document.createElement('div');
        box.style.cssText = boxStyle;
        box.innerHTML = `<h3>Wykryto niestandardowy adres odbioru</h3><p>Którego adresu użyć w Pocztex?</p>`;

        const btnStd = document.createElement('button');
        btnStd.textContent = `Nadawca (Standard)\n${senderData.city || '???'}`;
        btnStd.style.cssText = btnStyle + 'background-color: #6c757d;';
        btnStd.onclick = () => { saveAndRedirect(senderData, tracking, extraData); modal.remove(); };

        const btnCust = document.createElement('button');
        btnCust.innerText = `Niestandardowy\n${customData.city}`;
        btnCust.style.cssText = btnStyle + 'background-color: #d40000; color: white; border: 1px solid #ffcc00;';
        btnCust.onclick = () => { saveAndRedirect(customData, tracking, extraData); modal.remove(); };

        box.appendChild(btnStd);
        box.appendChild(btnCust);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    function saveAndRedirect(data, trackingNumber, extraData) {
        const payload = { ...data, ...extraData, trackingNumber: trackingNumber };
        GM_setValue('poczta_autofill', JSON.stringify(payload));
        GM_openInTab('https://e-nadawca.poczta-polska.pl/', { active: true });
    }

    // ================= CZĘŚĆ 2: E-NADAWCA (AUTOMATYKA) =================

    function initEnadawca() {
        const dataStr = GM_getValue('poczta_autofill');
        if (!dataStr) return;
        const data = JSON.parse(dataStr);

        console.log("E-nadawca Auto: Start", data);
        const info = document.createElement('div');
        info.innerHTML = `⏳ Przetwarzam: <b>${data.trackingNumber}</b>...`;
        info.style.cssText = "position:fixed; top:0; right:0; background:#d40000; color:white; padding:5px 10px; z-index:99999; font-family:sans-serif; font-size:12px;";
        document.body.appendChild(info);

        const loop = setInterval(() => {

            // 1. Logowanie
            if (document.getElementById('u') && document.getElementById('p')) {
                info.innerHTML = "🔒 Zaloguj się ręcznie...";
                return;
            }

            // ----------------------------------------------------
            // A. FINALNY FORMULARZ ZAMAWIANIA (Najgłębszy stan)
            // ----------------------------------------------------
            const formSender = document.getElementById('nadawca');
            const formReceiver = document.getElementById('odbior');
            const formWeight = document.getElementById('masa');
            const formQty = document.getElementById('ilosc');
            const formEmail = document.getElementById('email');

            if (formSender && formReceiver && formWeight) {

                if (formWeight.value === data.weight) {
                    info.innerHTML = "✅ Formularz gotowy. Sprawdź i wyślij.";
                    info.style.backgroundColor = "#28a745";
                    clearInterval(loop);
                    GM_deleteValue('poczta_autofill');
                    setTimeout(() => info.remove(), 5000);
                    return;
                }

                console.log("Wypełniam formularz zamówienia...");
                info.innerHTML = "📝 Wypełniam adres, email i wagę...";

                // --- Budowanie Stringa Adresowego (Firma + Imię) ---
                let addressLines = [];

                // 1. Firma
                if (data.company && data.company.length > 1) {
                    addressLines.push(data.company);
                }

                // 2. Imię i Nazwisko (dodajemy jeśli jest i jest inne niż nazwa firmy)
                if (data.name && data.name.length > 1 && data.name !== data.company) {
                    addressLines.push(data.name);
                }

                // 3. Reszta adresu
                addressLines.push(`${data.street} ${data.houseNo}${data.localNo ? '/' + data.localNo : ''}`);
                addressLines.push(`${data.postal} ${data.city}`);
                addressLines.push(`tel: ${data.phone}`);

                const addressString = addressLines.join('\n');

                // Wypełniamy pola textarea
                simulateInput(formSender, addressString);
                simulateInput(formReceiver, addressString);

                // Wypełniamy wagę i ilość
                simulateInput(formWeight, data.weight);
                simulateInput(formQty, "1");

                // Wypełniamy Email (jeśli istnieje pole i mamy dane)
                if (formEmail && data.email) {
                    simulateInput(formEmail, data.email);
                }

                // Wypełniamy PNA miejsca odbioru (kod pocztowy) i miejscowość
                const formPostalCode = document.getElementById('kod_pocztowy');
                const formCity = document.getElementById('miejscowosc');

                if (formPostalCode && data.postal) {
                    simulateInput(formPostalCode, data.postal);
                }
                if (formCity && data.city) {
                    simulateInput(formCity, data.city);
                }

                return;
            }

            // ----------------------------------------------------
            // B. SZCZEGÓŁY PRZESYŁKI -> Kliknij "Zamów kuriera"
            // ----------------------------------------------------
            const orderLink = document.querySelector('a[href*="action=ZamowKuriera"]');
            if (orderLink) {
                info.innerHTML = "🚚 Klikam 'Zamów kuriera'...";
                orderLink.click();
                return;
            }

            // ----------------------------------------------------
            // C. LISTA WYNIKÓW -> Kliknij w numer przesyłki
            // ----------------------------------------------------
            const allLinks = Array.from(document.querySelectorAll('a'));
            const shipmentLink = allLinks.find(a => a.textContent.trim() === data.trackingNumber);

            if (shipmentLink) {
                info.innerHTML = "➡️ Otwieram szczegóły przesyłki...";
                shipmentLink.click();
                return;
            }

            // ----------------------------------------------------
            // D. FORMULARZ WYSZUKIWANIA
            // ----------------------------------------------------
            const searchInput = document.getElementById('numer_nadania');
            if (searchInput) {
                if (searchInput.value === data.trackingNumber) {
                    info.innerHTML = "🔎 Szukam...";
                    return;
                }
                info.innerHTML = "✍️ Wpisuję numer...";
                simulateInput(searchInput, data.trackingNumber);
                const transmittedCheckbox = document.getElementById('transmitted');
                if (transmittedCheckbox && !transmittedCheckbox.checked) transmittedCheckbox.click();
                setTimeout(() => {
                    const submitBtn = document.getElementById('submit_button');
                    if (submitBtn) submitBtn.click();
                }, 600);
                return;
            }

            // ----------------------------------------------------
            // E. MENU GŁÓWNE -> Kliknij "Szukaj"
            // ----------------------------------------------------
            const menuLink = document.querySelector('a[href*="action=Search"]');
            if (menuLink && !searchInput) {
                info.innerHTML = "nav: Idę do szukania...";
                menuLink.click();
                return;
            }

        }, 500);
    }

    // ================= ROUTER =================
    if (window.location.hostname.includes('blpaczka.com')) {
        window.addEventListener('load', initBLPaczka);
    }
    else if (window.location.hostname.includes('poczta-polska.pl')) {
        if (document.readyState === 'complete') initEnadawca();
        else window.addEventListener('load', initEnadawca);
    }

})();
