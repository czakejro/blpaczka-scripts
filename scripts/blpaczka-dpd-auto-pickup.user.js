// ==UserScript==
// @name         BLPaczka - DPD Auto Pickup (v1.7 - DPD Detection)
// @namespace    http://tampermonkey.net/
// @version      1.9
// @description  Automatyzuje zamawianie DPD (Tylko dla zamówień DPD + Fix telefonu + Wymiary i waga przesyłki). v1.9: Fix opóźnienia renderowania pól wymiarów.
// @author       Gemini & User
// @match        *://*.blpaczka.com/admin/courier/orders/view/*
// @match        https://zk.dpd.com.pl/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ================= KONFIGURACJA DPD =================
    const DPD_FID = '352692';           // Nr klienta
    const DPD_NIP = '5213971463';       // NIP
    const FIXED_CONTACT_PERSON = 'BL Paczka'; // Osoba kontaktowa (Płatnik)
    const FIXED_ORDERER_EMAIL = 'info@blpaczka.com'; // Email Zleceniodawcy

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

    // ================= MODUŁ 1: BLPACZKA (Scraper) =================

    function initBLPaczka() {
        // --- DETEKCJA CZY TO ZAMÓWIENIE DPD ---
        let isDpdOrder = false;
        const tds = Array.from(document.querySelectorAll('td'));
        const priceLabel = tds.find(td => td.textContent.trim().includes('Cena przesyłki'));

        if (priceLabel && priceLabel.nextElementSibling) {
            const serviceName = priceLabel.nextElementSibling.textContent.toUpperCase();
            if (serviceName.includes('DPD')) {
                isDpdOrder = true;
            }
        }

        if (!isDpdOrder) return;

        // --- KONIEC DETEKCJI ---

        const h2Sender = Array.from(document.querySelectorAll('h2')).find(h => h.textContent.trim().toLowerCase() === 'dane nadawcy');
        const targetElement = h2Sender || document.querySelector('h2');
        if (!targetElement) return;

        if (document.getElementById('btn-dpd-auto')) return;

        const btn = document.createElement('button');
        btn.id = 'btn-dpd-auto';
        btn.textContent = '🔴 Zamów DPD (zk.dpd)';
        btn.style.cssText = 'margin-left: 15px; padding: 5px 10px; background-color: #DC0032; color: #fff; border: 2px solid #000; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 12px; vertical-align: middle;';

        btn.onclick = (e) => {
            e.preventDefault();
            handlePickupClick();
        };
        targetElement.appendChild(btn);
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
            packageInfo.length = packageMatch[2];
            packageInfo.width = packageMatch[3];
            packageInfo.height = packageMatch[4];
            packageInfo.dims = `${packageMatch[2]}/${packageMatch[3]}/${packageMatch[4]}`;
        } else {
            const weightMatch = htmlContent.match(/(\d+(?:[.,]\d+)?)\s*kg/i);
            if(weightMatch) packageInfo.weight = weightMatch[1].replace(',', '.');
            packageInfo.dims = '';
            packageInfo.length = '';
            packageInfo.width = '';
            packageInfo.height = '';
        }
        return packageInfo;
    }

    function handlePickupClick() {
        const sender = getTableData('dane nadawcy');
        const customPickup = getCustomPickupData();
        const packageInfo = getPackageData();

        const rawData = { sender, packageInfo };

        if (customPickup) {
            if (sender.email) customPickup.email = sender.email;
            showChoiceModal(rawData, customPickup);
        } else {
            saveAndRedirect(rawData.sender, rawData.packageInfo);
        }
    }

    function showChoiceModal(rawData, customPickup) {
        const modal = document.createElement('div');
        modal.style.cssText = modalStyle;
        const box = document.createElement('div');
        box.style.cssText = boxStyle;
        box.innerHTML = `<h3>DPD - Wybierz adres odbioru</h3><p>Którego adresu użyć jako miejsca odbioru?</p>`;

        const btnStd = document.createElement('button');
        btnStd.textContent = `Nadawca (Standard)\n${rawData.sender.city}`;
        btnStd.style.cssText = btnStyle + 'background-color: #6c757d;';
        btnStd.onclick = () => {
            saveAndRedirect(rawData.sender, rawData.packageInfo);
            modal.remove();
        };

        const btnCust = document.createElement('button');
        btnCust.innerText = `Niestandardowy\n${customPickup.city}`;
        btnCust.style.cssText = btnStyle + 'background-color: #DC0032; color: white; border: 1px solid #000;';
        btnCust.onclick = () => {
            saveAndRedirect(customPickup, rawData.packageInfo);
            modal.remove();
        };

        box.appendChild(btnStd);
        box.appendChild(btnCust);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    function saveAndRedirect(source, packageInfo) {
        let fullAddress = source.street || '';

        const dpdData = {
            company: source.company || '',
            nameSurname: source.name || (source.company ? 'Dział Logistyki' : ''),
            address: fullAddress,
            postal: source.postal || '',
            city: source.city || '',
            phone: cleanPhoneNumber(source.phone),
            email: source.email || '',
            weight: packageInfo.weight || '',
            dims: packageInfo.dims || '',
            length: packageInfo.length || '',
            width: packageInfo.width || '',
            height: packageInfo.height || ''
        };

        if (!dpdData.company && dpdData.nameSurname) dpdData.company = dpdData.nameSurname;
        if (!dpdData.nameSurname && dpdData.company) dpdData.nameSurname = dpdData.company;

        GM_setValue('dpd_autofill_data', JSON.stringify(dpdData));
        GM_openInTab('https://zk.dpd.com.pl/', { active: true });
    }

    // ================= MODUŁ 2: DPD (Strona zewnętrzna) =================

    async function initDPD() {
        const dataStr = GM_getValue('dpd_autofill_data');
        if (!dataStr) return;
        const data = JSON.parse(dataStr);
        console.log("DPD Script v1.8: Dane załadowane", data);

        const waitFor = (attributeSelector, timeout = 10000) => new Promise((resolve, reject) => {
            if (document.querySelector(attributeSelector)) return resolve(document.querySelector(attributeSelector));
            const obs = new MutationObserver(() => {
                if (document.querySelector(attributeSelector)) {
                    obs.disconnect();
                    resolve(document.querySelector(attributeSelector));
                }
            });
            obs.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { obs.disconnect(); reject(new Error(`Timeout: ${attributeSelector}`)); }, timeout);
        });

        const simulateInput = (selector, value) => {
            const el = document.querySelector(selector);
            if (!el) {
                console.warn("Nie znaleziono pola:", selector);
                return false;
            }

            try {
                el.focus();
                el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
            } catch (e) {
                console.error("Błąd podczas wypełniania pola:", selector, e);
            }
            return true;
        };

        // --- ETAP 1: EKRAN LOGOWANIA ---
        if (document.getElementById('fid')) {
            console.log("DPD: Ekran logowania...");
            const fidInput = document.getElementById('fid');
            const nipInput = document.getElementById('nip');
            const submitBtn = document.querySelector('button.submitBtn');

            if (fidInput && nipInput) {
                fidInput.value = DPD_FID;
                nipInput.value = DPD_NIP;
                fidInput.dispatchEvent(new Event('change'));

                if (submitBtn) {
                    submitBtn.click();
                    setTimeout(() => {
                        window.location.href = 'https://zk.dpd.com.pl/new-order';
                    }, 2000);
                    return;
                }
            }
        }

        // --- ETAP 2: FORMULARZ NEW-ORDER ---
        if (window.location.href.includes('new-order')) {
            console.log("DPD: Formularz zlecenia wykryty...");

            await new Promise(r => setTimeout(r, 1000));
            const formReady = await waitFor('[name="forwardingAddress.companyName"]');

            if (formReady) {
                console.log("DPD: Zaczynam wypełnianie...");

                // 1. DANE NADAWCY
                simulateInput('[name="forwardingAddress.companyName"]', data.company);
                simulateInput('[name="forwardingAddress.nameSurname"]', data.nameSurname);
                simulateInput('[name="forwardingAddress.address"]', data.address);
                simulateInput('[name="forwardingAddress.zipCode"]', data.postal);
                simulateInput('[name="forwardingAddress.city"]', data.city);
                simulateInput('[name="forwardingAddress.phone"]', data.phone);

                // --- PĘTLA POPRAWIAJĄCA (Fix znikającego telefonu) ---
                let checkCount = 0;
                const fixInterval = setInterval(() => {
                    checkCount++;
                    const phoneEl = document.querySelector('[name="forwardingAddress.phone"]');
                    if (phoneEl) {
                         if (!phoneEl.value || phoneEl.value === '') {
                             console.log("DPD: Telefon zniknął! Wpisuję ponownie...");
                             simulateInput('[name="forwardingAddress.phone"]', data.phone);
                         }
                    }
                    if (checkCount > 8) clearInterval(fixInterval);
                }, 500);

                // 2. PŁATNIK (Osoba kontaktowa)
                setTimeout(() => {
                    simulateInput('[name="payer.contactPerson"]', FIXED_CONTACT_PERSON);
                }, 600);

                // 3. CHECKBOX (ZLECENIODAWCA)
                setTimeout(() => {
                    const checkbox = document.querySelector('input.senderDataCheckbox') || document.getElementById('getSenderDataCheckbox');
                    if (checkbox && !checkbox.checked) {
                        console.log("DPD: Klikam checkbox...");
                        checkbox.click();
                        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, 1500);

                // 4. ZLECENIODAWCA - WYMUSZENIE (Force Fill)
                setTimeout(() => {
                    console.log("DPD: Uzupełniam Zleceniodawcę na sztywno...");
                    simulateInput('[name="orderer.phone"]', data.phone);
                    simulateInput('[name="orderer.email"]', FIXED_ORDERER_EMAIL);
                }, 2500);

                // 5. LICZBA PACZEK + WAGA + WYMIARY
                setTimeout(async () => {
                    console.log("DPD v1.8: Uzupełniam dane przesyłki (liczba, waga, wymiary)...");

                    // Wpisz liczbę paczek = 1
                    simulateInput('#origin-declaration-parcels-count', '1');

                    // Poczekaj aż pojawią się pola wymiarów (po wpisaniu liczby paczek)
                    try {
                        await waitFor('#origin-declaration-parcels-total-weight', 5000);
                        await new Promise(r => setTimeout(r, 300));

                        // Waga całkowita
                        if (data.weight) {
                            simulateInput('#origin-declaration-parcels-total-weight', data.weight);
                        }

                        // Waga najcięższej paczki (taka sama — mamy 1 paczkę)
                        if (data.weight) {
                            // Zaokrąglij do int dla tego pola (maxlength=4)
                            const weightInt = Math.ceil(parseFloat(data.weight)).toString();
                            simulateInput('#origin-declaration-heaviest-parcel-weight', weightInt);
                        }

                        // Pauza — DPD renderuje pola wymiarów po wpisaniu wagi
                        console.log("DPD v1.8: Czekam 2s na pola wymiarów...");
                        await new Promise(r => setTimeout(r, 2000));

                        // Czekaj aż pole wymiarów faktycznie będzie w DOM
                        try {
                            await waitFor('#origin-declaration-greatest-parcel-height', 5000);
                        } catch (e) {
                            console.warn("DPD v1.8: Pola wymiarów nie pojawiły się, próbuję mimo to...");
                        }

                        // Wymiary
                        if (data.height) simulateInput('#origin-declaration-greatest-parcel-height', data.height);
                        if (data.length) simulateInput('#origin-declaration-greatest-parcel-length', data.length);
                        if (data.width) simulateInput('#origin-declaration-greatest-parcel-width', data.width);

                        console.log("DPD v1.8: Wymiary wypełnione!", {
                            weight: data.weight,
                            length: data.length,
                            width: data.width,
                            height: data.height
                        });

                    } catch (e) {
                        console.warn("DPD v1.8: Pola wymiarów nie pojawiły się w czasie:", e);
                    }
                }, 3000);

                // Informacja
                const dimsInfo = data.dims ? ` | 📐 ${data.dims} cm` : '';
                const weightInfo = data.weight ? ` | ⚖️ ${data.weight} kg` : '';
                const info = document.createElement('div');
                info.innerHTML = `✅ DPD Auto-Fill v1.8:<br><b>Firma:</b> ${data.company}<br><b>Tel:</b> ${data.phone}${weightInfo}${dimsInfo}<br>Proszę sprawdzić poprawność!`;
                info.style.cssText = 'position:fixed; top:10px; right:10px; background:#DC0032; color:#fff; padding:15px; border-radius:5px; z-index:9999; font-weight:bold; font-family:sans-serif; border: 2px solid #000; text-align:left; font-size:12px;';
                document.body.appendChild(info);

                GM_deleteValue('dpd_autofill_data');
            }
        }
    }

    // ================= ROUTER =================
    if (window.location.hostname.includes('blpaczka.com')) {
        window.addEventListener('load', initBLPaczka);
        setTimeout(initBLPaczka, 1500);
    }
    else if (window.location.hostname.includes('dpd.com.pl')) {
        if (document.readyState === "complete") {
            initDPD();
        } else {
            window.addEventListener('load', initDPD);
        }
        setTimeout(initDPD, 1000);
    }

})();
