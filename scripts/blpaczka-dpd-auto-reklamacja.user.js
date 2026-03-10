// ==UserScript==
// @name         BLPaczka - DPD Auto Reklamacje
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Automatyzuje składanie reklamacji DPD. Konsultant wybiera powód reklamacji, skrypt otwiera formularz DPD i wypełnia stałe dane firmy. Auto-detekcja krajowa/zagraniczna.
// @author       czax
// @match        *://*.blpaczka.com/admin/courier/orders/view/*
// @match        https://zgloszenia.dpd.com.pl/*
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
        // Dane firmy (stałe)
        numkat: '352692',
        companyName: 'BL Logistics sp. z o.o.',
        street: 'Czerska 8/10',
        postalCode: '00-732',
        city: 'Warszawa',
        contactPerson: 'BL Paczka',
        email: 'reklamacje@blpaczka.com',
        bankAccount: '48114011400000390287001033',

        // Domyślne wartości
        serviceType: '0', // 0 = Przesyłka krajowa

        // Timeouty
        dataExpiryMs: 5 * 60 * 1000, // 5 minut
    };

    // Powody reklamacji (wartość select → label)
    const COMPLAINT_REASONS = [
        { value: '0', label: 'Uszkodzenie przesyłki' },
        { value: '1', label: 'Zaginięcie przesyłki' },
        { value: '2', label: 'Braki zawartości przesyłki' },
        { value: '3', label: 'Błąd na fakturze' },
        { value: '5', label: 'Opóźnienie przesyłki' },
        { value: '6', label: 'Niezrealizowanie zlecenia' },
        { value: '7', label: 'Odwołanie od reklamacji' },
        { value: '8', label: 'Uzupełnienie zgłoszenia' },
    ];

    // ================= STYLE =================

    const STYLES = {
        modal: `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.5); z-index: 10000;
            display: flex; justify-content: center; align-items: center;
            font-family: sans-serif;
        `,
        box: `
            background: white; padding: 24px; border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            max-width: 420px; width: 90%;
        `,
        title: `
            margin: 0 0 8px 0; color: #DC0032; font-size: 16px;
        `,
        subtitle: `
            margin: 0 0 16px 0; color: #666; font-size: 12px;
        `,
        reasonBtn: `
            display: block; width: 100%; margin: 4px 0; padding: 10px 14px;
            border: 1px solid #ddd; border-radius: 4px; background: #fff;
            cursor: pointer; font-size: 13px; text-align: left;
            transition: background 0.15s;
        `,
        reasonBtnHover: 'background: #f8f0f0; border-color: #DC0032;',
        cancelBtn: `
            display: block; width: 100%; margin: 12px 0 0 0; padding: 8px;
            border: none; border-radius: 4px; background: #f0f0f0;
            cursor: pointer; font-size: 12px; color: #666; text-align: center;
        `,
        notification: `
            position: fixed; top: 10px; right: 10px; padding: 15px 20px;
            border-radius: 8px; z-index: 99999; font-size: 14px;
            font-weight: bold; font-family: sans-serif;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        `,
    };

    // ================= UTILS =================

    function showNotification(message, type = 'success') {
        const colors = { success: '#28a745', error: '#dc3545', info: '#DC0032' };
        const el = document.createElement('div');
        el.innerHTML = message;
        el.style.cssText = STYLES.notification + `background:${colors[type] || colors.info}; color:#fff;`;
        document.body.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 5000);
    }

    function fillField(idOrSelector, value) {
        // Próbuj po ID, potem po selektorze
        let el = document.getElementById(idOrSelector) || document.querySelector(idOrSelector);
        if (!el || !value) return false;

        if (el.type === 'checkbox') {
            if (!el.checked) {
                el.click();
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;
        }

        if (el.tagName === 'SELECT') {
            el.value = value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            // DPD używa onchange inline — triggeruj też ręcznie
            if (el.onchange) el.onchange();
            return true;
        }

        el.focus();
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
    }

    function waitFor(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const el = document.querySelector(selector);
            if (el) return resolve(el);
            const obs = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) { obs.disconnect(); resolve(el); }
            });
            obs.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { obs.disconnect(); reject(new Error(`Timeout: ${selector}`)); }, timeout);
        });
    }

    // ================= MODUŁ 1: BLPACZKA =================

    function initBLPaczka() {
        // Guard: nie dodawaj przycisku ponownie
        if (document.getElementById('btn-dpd-complaint')) return;

        // Detekcja DPD
        let isDpd = false;
        let isExport = false;
        const tds = Array.from(document.querySelectorAll('td'));
        const priceLabel = tds.find(td => td.textContent.trim().includes('Cena przesyłki'));
        if (priceLabel && priceLabel.nextElementSibling) {
            const serviceName = priceLabel.nextElementSibling.textContent.toUpperCase();
            if (serviceName.includes('DPD')) {
                isDpd = true;
                if (serviceName.includes('EXPORT')) {
                    isExport = true;
                }
            }
        }

        // Sprawdź też "Wysłano z konta" na wypadek gdyby cennik był tam
        if (isDpd && !isExport) {
            const accountTd = tds.find(td => td.textContent.trim() === 'Wysłano z konta');
            if (accountTd && accountTd.nextElementSibling) {
                if (accountTd.nextElementSibling.textContent.toUpperCase().includes('EXPORT')) {
                    isExport = true;
                }
            }
        }

        if (!isDpd) return;

        // Pobierz nr listu
        const waybillTd = Array.from(document.querySelectorAll('td')).find(td => td.textContent.trim() === 'List przewozowy');
        if (!waybillTd || !waybillTd.nextElementSibling) return;
        const trackingNumber = waybillTd.nextElementSibling.querySelector('strong')?.textContent.trim() || '';
        if (!trackingNumber) return;

        // Dodaj przycisk obok nr listu
        const btn = document.createElement('button');
        btn.id = 'btn-dpd-complaint';
        btn.textContent = '⚠️ Złóż reklamację DPD';
        btn.style.cssText = 'margin-left:10px; padding:3px 10px; background:#DC0032; color:#fff; border:1px solid #b02a37; border-radius:4px; cursor:pointer; font-size:11px; vertical-align:middle; font-weight:bold;';

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            showReasonModal(trackingNumber, isExport);
        });

        waybillTd.nextElementSibling.appendChild(btn);
    }

    // --- MODAL WYBORU POWODU ---

    function showReasonModal(trackingNumber, isExport) {
        const modal = document.createElement('div');
        modal.style.cssText = STYLES.modal;

        const box = document.createElement('div');
        box.style.cssText = STYLES.box;

        const title = document.createElement('h3');
        title.style.cssText = STYLES.title;
        title.textContent = '⚠️ Reklamacja DPD';
        box.appendChild(title);

        const sub = document.createElement('p');
        sub.style.cssText = STYLES.subtitle;
        const exportInfo = isExport ? ' 🌍 (zagraniczna)' : ' 🇵🇱 (krajowa)';
        sub.textContent = `Przesyłka: ${trackingNumber}${exportInfo} — wybierz powód reklamacji:`;
        box.appendChild(sub);

        // Przyciski powodów
        COMPLAINT_REASONS.forEach(reason => {
            const btn = document.createElement('button');
            btn.textContent = reason.label;
            btn.style.cssText = STYLES.reasonBtn;
            btn.addEventListener('mouseenter', () => {
                btn.style.background = '#f8f0f0';
                btn.style.borderColor = '#DC0032';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.background = '#fff';
                btn.style.borderColor = '#ddd';
            });
            btn.addEventListener('click', () => {
                modal.remove();
                saveAndRedirect(trackingNumber, reason.value, isExport);
            });
            box.appendChild(btn);
        });

        // Anuluj
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '✖ Anuluj';
        cancelBtn.style.cssText = STYLES.cancelBtn;
        cancelBtn.addEventListener('click', () => modal.remove());
        box.appendChild(cancelBtn);

        modal.appendChild(box);
        document.body.appendChild(modal);

        // Zamknij klikając tło
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
    }

    function saveAndRedirect(trackingNumber, reasonValue, isExport) {
        const complaintData = {
            tracking: trackingNumber,
            reason: reasonValue,
            serviceType: isExport ? '1' : '0', // 0=krajowa, 1=zagraniczna
        };

        GM_setValue('dpd_complaint_data', JSON.stringify(complaintData));
        GM_setValue('dpd_complaint_timestamp', Date.now());

        GM_openInTab('https://zgloszenia.dpd.com.pl/showComplaintForm', { active: true });
    }

    // ================= MODUŁ 2: DPD FORMULARZ =================

    async function initDPD() {
        const dataStr = GM_getValue('dpd_complaint_data');
        const timestamp = GM_getValue('dpd_complaint_timestamp');

        if (!dataStr || !timestamp) return;
        if (Date.now() - timestamp > CONFIG.dataExpiryMs) {
            GM_deleteValue('dpd_complaint_data');
            GM_deleteValue('dpd_complaint_timestamp');
            return;
        }

        const data = JSON.parse(dataStr);
        GM_deleteValue('dpd_complaint_data');
        GM_deleteValue('dpd_complaint_timestamp');

        console.log('[BLPaczka DPD Reklamacja v1.0] Start:', data);

        // Czekaj na formularz
        try {
            await waitFor('#complaintData_selComplaintList');
        } catch (e) {
            showNotification('⚠️ Nie znaleziono formularza DPD', 'error');
            return;
        }

        await new Promise(r => setTimeout(r, 500));

        // --- KROK 1: Wybierz powód reklamacji ---
        const selectEl = document.getElementById('complaintData_selComplaintList');
        if (selectEl) {
            selectEl.value = data.reason;
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            // DPD ma inline onchange — wywołaj ręcznie
            if (typeof onComplaintListChange === 'function') {
                try { onComplaintListChange(data.reason); } catch(e) {}
            } else if (selectEl.onchange) {
                selectEl.onchange();
            }
        }

        // Poczekaj na pojawienie się pól po wybraniu powodu
        await new Promise(r => setTimeout(r, 1500));

        // --- KROK 2: Dane przesyłki ---
        fillField('complaintData_letterNo', data.tracking);

        // Rodzaj przesyłki (krajowa/zagraniczna — auto-wykryte z cennika)
        fillField('complaintData_selServiceTypeList', data.serviceType || '0');

        // --- KROK 3: Dane reklamującego ---
        // Zaznacz "Przedsiębiorca"
        const bizCheckbox = document.getElementById('complaintData_selBusinessman');
        if (bizCheckbox && !bizCheckbox.checked) {
            bizCheckbox.click();
            bizCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
        }

        await new Promise(r => setTimeout(r, 500));

        // --- KROK 4: Dane do korespondencji ---
        // NUMKAT/płatnik
        fillField('complaintData_complainantData_fid', CONFIG.numkat);

        // Nazwa klienta
        fillField('complaintData_complainantData_name', CONFIG.companyName);

        // Ulica
        fillField('complaintData_complainantData_address', CONFIG.street);

        // Kod pocztowy
        fillField('complaintData_complainantData_postalCode', CONFIG.postalCode);

        // Miasto
        fillField('complaintData_complainantData_city', CONFIG.city);

        // Osoba kontaktowa
        fillField('complaintData_complainantData_contactPerson', CONFIG.contactPerson);

        // E-mail
        fillField('complaintData_complainantData_email', CONFIG.email);

        // Nr konta bankowego
        fillField('complaintData_complainantData_bankAccount', CONFIG.bankAccount);

        // --- FEEDBACK ---
        const reasonLabel = COMPLAINT_REASONS.find(r => r.value === data.reason)?.label || data.reason;
        showNotification(
            `✅ <b>BLPaczka:</b> Reklamacja DPD wypełniona<br>` +
            `📦 ${data.tracking}<br>` +
            `📋 ${reasonLabel}`,
            'info'
        );

        console.log('[BLPaczka DPD Reklamacja v1.0] Formularz wypełniony!');
    }

    // Helper: znajdź input w wierszu tabeli na podstawie labela
    function findInputByLabel(labelText) {
        const allTds = Array.from(document.querySelectorAll('td'));
        for (const td of allTds) {
            if (td.textContent.trim().toLowerCase().includes(labelText.toLowerCase())) {
                // Szukaj inputa w tym samym wierszu lub następnej komórce
                const row = td.closest('tr');
                if (row) {
                    const input = row.querySelector('input[type="text"], input:not([type])');
                    if (input) return input;
                }
                // Albo w następnym siblingu
                const nextTd = td.nextElementSibling;
                if (nextTd) {
                    const input = nextTd.querySelector('input');
                    if (input) return input;
                }
            }
        }
        return null;
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
    else if (host.includes('dpd.com.pl') && window.location.pathname.includes('ComplaintForm')) {
        if (document.readyState === 'complete') {
            setTimeout(initDPD, 1000);
        } else {
            window.addEventListener('load', () => setTimeout(initDPD, 1000));
        }
    }

})();
