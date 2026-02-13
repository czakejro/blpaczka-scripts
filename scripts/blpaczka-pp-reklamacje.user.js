// ==UserScript==
// @name         BLPaczka - Poczta Polska Reklamacje
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Automatyczne składanie reklamacji w E-nadawca Poczta Polska. Przycisk na BLPaczka, auto-nawigacja i wypełnianie formularza.
// @author       Claude & Łukasz
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

    // ================= KONFIGURACJA =================
    const CONFIG = {
        dataExpiryMs: 10 * 60 * 1000,
        btnClass: 'bl-pp-complaint-btn',
        storageKey: 'pp_complaint_data',
        storageTimestamp: 'pp_complaint_timestamp',
        bankAccount: '48114011400000390287001033', // bez spacji!
        loopIntervalMs: 600,
    };

    // Rodzaje reklamacji — label musi dokładnie odpowiadać tekstowi w accordion na e-nadawca
    const CLAIM_TYPES = [
        { key: 'ZAGINIECIE', label: 'Zaginięcie przesyłki' },
        { key: 'USZKODZENIE', label: 'Uszkodzenie zawartości' },
        { key: 'UBYTEK', label: 'Ubytek zawartości' },
        { key: 'OPOZNIENIE', label: 'Opóźnienie' },
        { key: 'ZWROT', label: 'Zwrot przesyłki niezgodnie z terminem' },
        { key: 'EPO_NIEPRAWIDLOWE', label: 'Nieprawidłowe wypełnienie potw. odb./EPO' },
        { key: 'EPO_NIEWYKONANIE', label: 'Niewykonanie usługi EPO' },
        { key: 'INNE', label: 'Inne' },
    ];

    // ================= UTILS =================

    function showNotification(message, type = 'info') {
        document.querySelectorAll('.bl-pp-notification').forEach(el => el.remove());
        const colors = { success: '#28a745', error: '#dc3545', info: '#d40000', wait: '#0d6efd' };
        const el = document.createElement('div');
        el.className = 'bl-pp-notification';
        el.innerHTML = message;
        el.style.cssText = `position:fixed; top:0; right:0; background:${colors[type] || colors.info}; color:#fff; padding:8px 15px; z-index:99999; font-family:sans-serif; font-size:12px; font-weight:bold; box-shadow: 0 2px 8px rgba(0,0,0,0.3); max-width:400px; line-height:1.4;`;
        document.body.appendChild(el);
        if (type === 'success') {
            setTimeout(() => {
                el.style.opacity = '0';
                setTimeout(() => el.remove(), 300);
            }, 6000);
        }
        return el;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function getData() {
        try {
            const dataStr = GM_getValue(CONFIG.storageKey);
            const timestamp = GM_getValue(CONFIG.storageTimestamp);
            if (!dataStr || !timestamp) return null;
            if (Date.now() - timestamp > CONFIG.dataExpiryMs) { cleanupStorage(); return null; }
            return JSON.parse(dataStr);
        } catch (err) {
            cleanupStorage();
            return null;
        }
    }

    function saveData(data) {
        GM_setValue(CONFIG.storageKey, JSON.stringify(data));
        GM_setValue(CONFIG.storageTimestamp, Date.now());
    }

    function cleanupStorage() {
        GM_deleteValue(CONFIG.storageKey);
        GM_deleteValue(CONFIG.storageTimestamp);
    }

    function simulateInput(element, value) {
        if (!element) return;
        element.value = value;
        element.dispatchEvent(new Event('focus', { bubbles: true }));
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    // ================= MODUŁ 1: BLPACZKA =================

    function getTrackingNumber() {
        const bodyText = document.body.innerText;
        const match = bodyText.match(/(PX\d+)/);
        if (match) return match[1];
        const tds = Array.from(document.querySelectorAll('td'));
        const trackingTd = tds.find(td => td.textContent.includes('PX'));
        return trackingTd ? trackingTd.textContent.trim().split(' ')[0] : null;
    }

    function getAccountName() {
        const td = Array.from(document.querySelectorAll('td'))
            .find(td => td.textContent.trim() === 'Wysłano z konta');
        return td?.nextElementSibling?.textContent || '';
    }

    function showClaimTypeDialog(trackingNumber) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:99999; display:flex; align-items:center; justify-content:center;';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:#fff; border-radius:12px; padding:30px; min-width:420px; max-width:520px; box-shadow:0 8px 32px rgba(0,0,0,0.3); font-family:sans-serif;';

        const title = document.createElement('h3');
        title.textContent = `Reklamacja PP: ${trackingNumber}`;
        title.style.cssText = 'margin:0 0 8px 0; color:#d40000; font-size:18px;';
        dialog.appendChild(title);

        const subtitle = document.createElement('p');
        subtitle.textContent = 'Wybierz rodzaj reklamacji:';
        subtitle.style.cssText = 'margin:0 0 16px 0; color:#666; font-size:14px;';
        dialog.appendChild(subtitle);

        return new Promise((resolve) => {
            // Główne (częste) na górze
            const frequent = ['ZAGINIECIE', 'USZKODZENIE', 'UBYTEK'];
            const frequentTypes = CLAIM_TYPES.filter(ct => frequent.includes(ct.key));
            const otherTypes = CLAIM_TYPES.filter(ct => !frequent.includes(ct.key));

            frequentTypes.forEach(claim => {
                const btn = document.createElement('button');
                btn.textContent = claim.label;
                btn.style.cssText = 'display:block; width:100%; padding:12px 16px; margin-bottom:8px; background:#fff3f3; border:2px solid #d40000; border-radius:8px; cursor:pointer; font-size:14px; text-align:left; font-weight:bold; transition: all 0.15s;';
                btn.onmouseover = () => { btn.style.background = '#ffcc00'; };
                btn.onmouseout = () => { btn.style.background = '#fff3f3'; };
                btn.onclick = () => { overlay.remove(); resolve(claim); };
                dialog.appendChild(btn);
            });

            // Separator
            const sep = document.createElement('div');
            sep.style.cssText = 'border-top:1px solid #eee; margin:12px 0; padding-top:4px;';
            sep.innerHTML = '<small style="color:#999;">Pozostałe rodzaje:</small>';
            dialog.appendChild(sep);

            otherTypes.forEach(claim => {
                const btn = document.createElement('button');
                btn.textContent = claim.label;
                btn.style.cssText = 'display:block; width:100%; padding:10px 16px; margin-bottom:6px; background:#f8f8f8; border:1px solid #ddd; border-radius:8px; cursor:pointer; font-size:13px; text-align:left; transition: all 0.15s;';
                btn.onmouseover = () => { btn.style.background = '#ffcc00'; };
                btn.onmouseout = () => { btn.style.background = '#f8f8f8'; };
                btn.onclick = () => { overlay.remove(); resolve(claim); };
                dialog.appendChild(btn);
            });

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Anuluj';
            cancelBtn.style.cssText = 'display:block; width:100%; padding:10px 16px; margin-top:12px; background:transparent; border:1px solid #ccc; border-radius:8px; cursor:pointer; font-size:13px; color:#666;';
            cancelBtn.onclick = () => { overlay.remove(); resolve(null); };
            dialog.appendChild(cancelBtn);

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) { overlay.remove(); resolve(null); }
            });
        });
    }

    function initBLPaczka() {
        if (document.querySelector(`.${CONFIG.btnClass}`)) return;

        const accountName = getAccountName().toLowerCase();
        if (!accountName.includes('poczta polska') && !accountName.includes('pocztex')) return;

        const trackingNumber = getTrackingNumber();
        if (!trackingNumber) return;

        // Wstawiamy przycisk obok numeru listu przewozowego
        const waybillTd = Array.from(document.querySelectorAll('td'))
            .find(td => td.textContent.trim() === 'List przewozowy');
        if (!waybillTd || !waybillTd.nextElementSibling) return;

        const btn = document.createElement('button');
        btn.textContent = '⚠️ Reklamacja PP/Pocztex';
        btn.className = CONFIG.btnClass;
        btn.style.cssText = 'margin-left:10px; padding:3px 10px; background:#ffcc00; color:#000; border:2px solid #d40000; border-radius:4px; cursor:pointer; font-size:11px; font-weight:bold; vertical-align:middle;';

        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const claim = await showClaimTypeDialog(trackingNumber);
            if (!claim) return;

            saveData({
                trackingNumber: trackingNumber,
                claimType: claim.key,
                claimLabel: claim.label,
                step: 'search',
            });
            GM_openInTab('https://e-nadawca.poczta-polska.pl/', { active: true });
        });

        waybillTd.nextElementSibling.appendChild(btn);
    }

    // ================= MODUŁ 2: E-NADAWCA =================

    function initEnadawca() {
        const data = getData();
        if (!data || !data.trackingNumber || !data.claimType) return;

        console.log('PP Reklamacja: start', data);
        const info = showNotification(
            `⏳ Reklamacja: <b>${data.trackingNumber}</b><br>Typ: ${data.claimLabel}`,
            'info'
        );

        const loop = setInterval(() => {

            // Odczytaj aktualny step z storage (może się zmienić)
            const currentData = getData();
            if (!currentData) { clearInterval(loop); return; }
            const step = currentData.step;

            // --------------------------------------------------
            // 0. Logowanie — czekaj
            // --------------------------------------------------
            if (document.getElementById('u') && document.getElementById('p')) {
                info.innerHTML = '🔒 Zaloguj się ręcznie...';
                return;
            }

            // --------------------------------------------------
            // STEP: form — Formularz reklamacji (żądam odszkodowania + rachunek)
            // --------------------------------------------------
            if (step === 'form') {
                const radioOdszkodowanie = document.querySelector('input[name="zadanie"][value="2"]');
                const nrbField = document.getElementById('nrb');

                if (radioOdszkodowanie && nrbField) {
                    // Zaznacz "żądam odszkodowania"
                    if (!radioOdszkodowanie.checked) {
                        radioOdszkodowanie.click();
                        radioOdszkodowanie.dispatchEvent(new Event('change', { bubbles: true }));
                    }

                    // Wpisz rachunek bankowy
                    if (nrbField.value !== CONFIG.bankAccount) {
                        simulateInput(nrbField, CONFIG.bankAccount);
                    }

                    info.innerHTML = '✅ Odszkodowanie zaznaczone, rachunek wpisany.<br>Uzupełnij <b>opis</b> i wyślij ręcznie.';
                    info.style.backgroundColor = '#28a745';
                    clearInterval(loop);
                    cleanupStorage();
                    setTimeout(() => info.remove(), 8000);
                    return;
                }
                // Jeśli nie znaleziono pól — czekaj, strona może się jeszcze ładować
                return;
            }

            // --------------------------------------------------
            // STEP: claim_subcategory — Kliknij link ajax z rodzajem reklamacji
            // Po kliknięciu accordion pojawia się a.ajax-link-click z href do RejestrujReklamacje
            // --------------------------------------------------
            if (step === 'claim_subcategory') {
                // Szukaj linku ajax-link-click z pasującym tekstem
                const ajaxLinks = document.querySelectorAll('a.ajax-link-click');
                for (const link of ajaxLinks) {
                    if (link.textContent.trim() === currentData.claimLabel) {
                        info.innerHTML = `Klikam: <b>${currentData.claimLabel}</b>`;
                        currentData.step = 'form';
                        saveData(currentData);
                        link.click();
                        return;
                    }
                }
                // Link może się jeszcze nie pojawił — czekaj
                return;
            }

            // --------------------------------------------------
            // STEP: claim_type_list — Kliknij kategorię w accordion (poziom 1)
            // --------------------------------------------------
            if (step === 'claim_type_list') {
                // Najpierw sprawdź czy ajax-link-click już jest widoczny (accordion już otwarty)
                const ajaxLinks = document.querySelectorAll('a.ajax-link-click');
                for (const link of ajaxLinks) {
                    if (link.textContent.trim() === currentData.claimLabel) {
                        // Accordion już otwarty, przeskocz od razu do subcategory
                        info.innerHTML = `Klikam: <b>${currentData.claimLabel}</b>`;
                        currentData.step = 'form';
                        saveData(currentData);
                        link.click();
                        return;
                    }
                }

                // Accordion jeszcze zamknięty — kliknij kategorię
                const catLinks = document.querySelectorAll('a.accordion-toggle');
                for (const link of catLinks) {
                    if (link.textContent.trim() === currentData.claimLabel) {
                        info.innerHTML = `Otwieram kategorię: <b>${currentData.claimLabel}</b>`;
                        currentData.step = 'claim_subcategory';
                        saveData(currentData);
                        link.click();
                        return;
                    }
                }
                return;
            }

            // --------------------------------------------------
            // STEP: detail — Szczegóły przesyłki → kliknij "Reklamacja"
            // --------------------------------------------------
            if (step === 'detail') {
                const reklamacjaBtn = Array.from(document.querySelectorAll('button.widgetButton'))
                    .find(btn => btn.textContent.trim() === 'Reklamacja');

                if (reklamacjaBtn) {
                    info.innerHTML = '📋 Klikam Reklamacja...';
                    currentData.step = 'claim_type_list';
                    saveData(currentData);
                    reklamacjaBtn.click();
                    return;
                }
                // Może strona jeszcze się ładuje
                return;
            }

            // --------------------------------------------------
            // STEP: search — Nawigacja do wyszukiwania i szukanie przesyłki
            // --------------------------------------------------
            if (step === 'search') {

                // C. Lista wyników — kliknij w numer przesyłki
                const allLinks = Array.from(document.querySelectorAll('a'));
                const shipmentLink = allLinks.find(a => a.textContent.trim() === currentData.trackingNumber);
                if (shipmentLink) {
                    info.innerHTML = '➡️ Otwieram szczegóły przesyłki...';
                    currentData.step = 'detail';
                    saveData(currentData);
                    shipmentLink.click();
                    return;
                }

                // D. Formularz wyszukiwania — wpisz numer
                const searchInput = document.getElementById('numer_nadania');
                if (searchInput) {
                    if (searchInput.value === currentData.trackingNumber) {
                        info.innerHTML = '🔎 Szukam...';
                        return;
                    }
                    info.innerHTML = '✍️ Wpisuję numer...';
                    simulateInput(searchInput, currentData.trackingNumber);
                    const transmittedCheckbox = document.getElementById('transmitted');
                    if (transmittedCheckbox && !transmittedCheckbox.checked) transmittedCheckbox.click();
                    setTimeout(() => {
                        const submitBtn = document.getElementById('submit_button');
                        if (submitBtn) submitBtn.click();
                    }, 600);
                    return;
                }

                // E. Menu główne → kliknij Szukaj
                const menuLink = document.querySelector('a[href*="action=Search"]');
                if (menuLink) {
                    info.innerHTML = 'nav: Idę do szukania...';
                    menuLink.click();
                    return;
                }
            }

        }, CONFIG.loopIntervalMs);
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
    else if (host.includes('poczta-polska.pl')) {
        if (document.readyState === 'complete') initEnadawca();
        else window.addEventListener('load', initEnadawca);
    }
})();
