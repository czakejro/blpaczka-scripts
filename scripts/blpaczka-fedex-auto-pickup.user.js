// ==UserScript==
// @name         BLPaczka - FedEx Auto Pickup (v1.4 - Custom Address)
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Automatyzuje zamawianie FedEx. Obsługa niestandardowego adresu odbioru (zostawia PL znaki).
// @author       Gemini & User
// @match        *://*.blpaczka.com/admin/courier/orders/view/*
// @match        https://mydelivery.emea.fedex.com/webpickup/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ================= KONFIGURACJA =================
    const FEDEX_ACCOUNT_NUMBER = '579717119';

    function cleanPhoneNumber(phone) {
        if (!phone) return '';
        let cleaned = phone.replace(/\D/g, '');
        cleaned = cleaned.replace(/^0+/, '');
        if (cleaned.length === 11 && cleaned.startsWith('48')) cleaned = cleaned.substring(2);
        return cleaned;
    }

    // STYLE MODALA
    const modalStyle = `position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; display: flex; justify-content: center; align-items: center; font-family: sans-serif;`;
    const boxStyle = `background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); text-align: center; max-width: 400px; width: 90%;`;
    const btnStyle = `margin: 10px; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; color: white;`;


    // ================= MODUŁ 1: BLPACZKA =================

    function initBLPaczka() {
        let isFedEx = false;
        const accountLabelTd = Array.from(document.querySelectorAll('td')).find(td => td.textContent.trim() === 'Wysłano z konta');
        if (accountLabelTd && accountLabelTd.nextElementSibling) {
            if (accountLabelTd.nextElementSibling.textContent.toUpperCase().includes('FEDEX')) isFedEx = true;
        }
        if (!isFedEx) return;

        const h2Sender = Array.from(document.querySelectorAll('h2')).find(h => h.textContent.trim().toLowerCase() === 'dane nadawcy');
        const targetElement = h2Sender || document.querySelector('h2');
        if (!targetElement) return;

        const btn = document.createElement('button');
        btn.textContent = '🟣 Zamów FedEx (3-strona)';
        btn.style.cssText = 'margin-left: 15px; padding: 5px 10px; background-color: #4d148c; color: #fff; border: 2px solid #ff6600; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 12px; vertical-align: middle;';

        btn.onclick = (e) => {
            e.preventDefault();
            handlePickupClick();
        };
        targetElement.appendChild(btn);
    }

    // --- POBIERANIE DANYCH ---

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
            else if (label.includes('e-mail') || label.includes('email') || (val.includes('@') && val.length < 50)) data.email = val;
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

    function getPackageData() {
        const contentBox = document.getElementById('content') || document.body;
        const htmlContent = contentBox.innerHTML;
        const packageMatch = htmlContent.match(/(\d+(?:[.,]\d+)?)\s*kg.*?(\d+)\s*cm\s*\/\s*(\d+)\s*cm\s*\/\s*(\d+)\s*cm/i);
        const packageInfo = {};
        if (packageMatch) {
            packageInfo.weight = packageMatch[1].replace(',', '.');
            packageInfo.dims = `${packageMatch[2]}/${packageMatch[3]}/${packageMatch[4]}`;
        } else {
            const weightMatch = htmlContent.match(/(\d+(?:[.,]\d+)?)\s*kg/i);
            if(weightMatch) packageInfo.weight = weightMatch[1].replace(',', '.');
            packageInfo.dims = '';
        }
        return packageInfo;
    }

    // --- LOGIKA WYBORU ---

    function handlePickupClick() {
        const sender = getTableData('dane nadawcy');
        const recipient = getTableData('dane adresata');
        const customPickup = getCustomPickupData();
        const packageInfo = getPackageData();

        const rawData = { sender, recipient, packageInfo };

        if (customPickup) {
            // FIX: Przekazujemy email Nadawcy do customa
            if (sender.email) customPickup.email = sender.email;

            showChoiceModal(rawData, customPickup);
        } else {
            saveAndRedirect(rawData.sender, rawData.recipient, rawData.packageInfo);
        }
    }

    function showChoiceModal(rawData, customPickup) {
        const modal = document.createElement('div');
        modal.style.cssText = modalStyle;
        const box = document.createElement('div');
        box.style.cssText = boxStyle;
        box.innerHTML = `<h3>Wykryto niestandardowy adres odbioru</h3><p>Którego adresu użyć jako NADAWCY (Odbiór)?</p>`;

        const btnStd = document.createElement('button');
        btnStd.textContent = `Nadawca (Standard)\n${rawData.sender.city}`;
        btnStd.style.cssText = btnStyle + 'background-color: #6c757d;';
        btnStd.onclick = () => {
            saveAndRedirect(rawData.sender, rawData.recipient, rawData.packageInfo);
            modal.remove();
        };

        const btnCust = document.createElement('button');
        btnCust.innerText = `Niestandardowy\n${customPickup.city}`;
        btnCust.style.cssText = btnStyle + 'background-color: #4d148c; color: white; border: 1px solid #ff6600;';
        btnCust.onclick = () => {
            // Tu podmieniamy nadawcę na customPickup
            saveAndRedirect(customPickup, rawData.recipient, rawData.packageInfo);
            modal.remove();
        };

        box.appendChild(btnStd);
        box.appendChild(btnCust);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    function saveAndRedirect(senderSource, recipientSource, packageInfo) {
        const mapData = (source) => {
            let finalCompany = source.company;
            if (!finalCompany || finalCompany.trim().length < 2) finalCompany = source.name;
            let finalContact = source.name;
            if (!finalContact || finalContact.trim().length < 2) finalContact = source.company;

            return {
                company: finalCompany || '',
                contact: finalContact || '',
                full_address: source.street || '',
                postal: source.postal || '',
                city: source.city || '',
                phone: cleanPhoneNumber(source.phone),
                email: source.email || ''
            };
        };

        const fedexData = {
            sender: mapData(senderSource),
            recipient: mapData(recipientSource),
            weight: packageInfo.weight || '',
            dims: packageInfo.dims || ''
        };

        GM_setValue('fedex_autofill_data', JSON.stringify(fedexData));
        GM_setValue('fedex_autofill_timestamp', Date.now());

        GM_openInTab('https://mydelivery.emea.fedex.com/webpickup/', { active: true });
    }

    // ================= MODUŁ 2: FEDEX =================

    async function initFedEx() {
        const dataStr = GM_getValue('fedex_autofill_data');
        if (!dataStr) return;
        const data = JSON.parse(dataStr);

        console.log("FedEx Script: Start...", data);

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

        const fillField = (id, value) => {
            const el = document.getElementById(id);
            if (el && value) {
                el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
                return true;
            }
            return false;
        };

        const parseInfo = (fullAddress, contactName) => {
            let street = fullAddress || '';
            let houseNo = '', localNo = '';
            const addressMatch = street.match(/^(.+?)\s+(\d.*)$/);
            if (addressMatch) {
                street = addressMatch[1];
                const fullNumber = addressMatch[2];
                if (fullNumber.includes('/')) {
                    [houseNo, localNo] = fullNumber.split('/');
                } else {
                    houseNo = fullNumber;
                }
            }

            let firstName = '', lastName = '';
            if(contactName) {
                const nameParts = contactName.split(' ');
                if (nameParts.length > 0) {
                    firstName = nameParts[0];
                    lastName = nameParts.slice(1).join(' ');
                }
                if (!lastName) lastName = firstName;
            }
            return { street, houseNo, localNo, firstName, lastName };
        };

        const sInfo = parseInfo(data.sender.full_address, data.sender.contact);
        const rInfo = parseInfo(data.recipient.full_address, data.recipient.contact);

        await waitFor('body');

        // 1. Umowa
        const labels = Array.from(document.querySelectorAll('label'));
        const contractLabel = labels.find(l => l.textContent.includes('Składam zlecenie w imieniu Firmy'));
        if (contractLabel) {
            contractLabel.click();
            const r = contractLabel.querySelector('input');
            if(r) r.click();
        }

        // 2. Płatnik
        await new Promise(r => setTimeout(r, 800));
        const senderLabel = Array.from(document.querySelectorAll('label, span')).find(l => l.textContent.trim() === 'Nadawca');
        if (senderLabel) senderLabel.click();

        // 3. Nr klienta + BLUR
        await waitFor('#payerId');
        const payerInput = document.getElementById('payerId');
        if(payerInput) {
            payerInput.value = FEDEX_ACCOUNT_NUMBER;
            payerInput.dispatchEvent(new Event('input', { bubbles: true }));
            payerInput.dispatchEvent(new Event('change', { bubbles: true }));
            payerInput.dispatchEvent(new Event('blur', { bubbles: true }));
        }

        // 4. CZEKANIE
        console.log("Czekam na walidację konta...");
        await new Promise(r => setTimeout(r, 3000));

        // 5. Wypełnianie
        console.log("Wypełniam pola...");

        let attempts = 0;
        const interval = setInterval(() => {
            attempts++;
            if (attempts > 15) clearInterval(interval);

            // NADAWCA
            fillField('senderCompanyName', data.sender.company);
            fillField('senderName', sInfo.firstName);
            fillField('senderSurname', sInfo.lastName);
            fillField('senderStreet', sInfo.street);
            fillField('senderHouseNo', sInfo.houseNo);
            fillField('senderAptNo', sInfo.localNo);
            fillField('senderZipCode', data.sender.postal);
            fillField('senderCity', data.sender.city);
            fillField('senderPhoneNo', data.sender.phone);

            fillField('orderEmail', data.sender.email);
            fillField('orderEmailConfirmation', data.sender.email);

            // ADRESAT
            fillField('receiverCompanyName', data.recipient.company);
            fillField('receiverName', rInfo.firstName);
            fillField('receiverSurname', rInfo.lastName);
            fillField('receiverStreet', rInfo.street);
            fillField('receiverHouseNo', rInfo.houseNo);
            fillField('receiverAptNo', rInfo.localNo);
            fillField('receiverZipCode', data.recipient.postal);
            fillField('receiverCity', data.recipient.city);
            fillField('receiverPhoneNo', data.recipient.phone);

            // PACZKA
            const dateInput = document.getElementById('pickupDateAlt');
            if (dateInput && !dateInput.value) {
                dateInput.click();
                setTimeout(() => {
                    const todayBtn = document.querySelector('.flatpickr-day.today');
                    if (todayBtn) todayBtn.click();
                }, 100);
            }
            fillField('shipmentAmount', '1');
            fillField('shipmentWeight', data.weight);
            fillField('shipmentDim', data.dims);

            // ZGODY
            const c1 = document.querySelector('input[name="personalInfoData"]');
            if (c1 && !c1.checked) c1.click();
            const c2 = document.querySelector('input[name="validFormData"]');
            if (c2 && !c2.checked) c2.click();

        }, 500);

        const info = document.createElement('div');
        info.innerHTML = `✅ FedEx (3-strona):<br><b>Nadawca (BL):</b> ${sInfo.street || 'BRAK'}<br><b>Odbiorca (BL):</b> ${rInfo.street || 'BRAK'}`;
        info.style.cssText = 'position:fixed; top:10px; right:10px; background:#4d148c; color:#fff; padding:15px; border-radius:5px; z-index:9999; font-weight:bold; font-family:sans-serif; border: 2px solid #ff6600; text-align:left; font-size:11px;';
        document.body.appendChild(info);

        GM_deleteValue('fedex_autofill_data');
    }

    // ================= ROUTER =================
    if (window.location.hostname.includes('blpaczka.com')) {
        window.addEventListener('load', initBLPaczka);
        setTimeout(initBLPaczka, 1500);
    }
    else if (window.location.hostname.includes('fedex.com')) {
        initFedEx();
    }
})();