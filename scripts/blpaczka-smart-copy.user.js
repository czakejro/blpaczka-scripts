// ==UserScript==
// @name         BLPaczka - Smart Copy (Tylko Kopiowanie - Ver 1.4 Split)
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Wersja "Split" - dodaje ikonki kopiowania do KAŻDEJ linii adresu oddzielnie (Miasto, Kod, Ulica).
// @author       Gemini & User
// @match        *://*.blpaczka.com/admin/courier/orders/view/*
// @match        *://blpaczka.com/admin/courier/orders/view/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ================= STYLIZACJA =================
    const STYLES = `
        /* Mała ikona - PUSTA w HTML, treść w CSS */
        .gemini-copy-icon {
            cursor: pointer;
            margin-left: 6px;
            font-size: 14px;
            opacity: 0.4;
            transition: all 0.2s ease;
            display: inline-block;
            vertical-align: middle;
            width: 16px;
            height: 16px;
        }
        .gemini-copy-icon::after {
            content: "📑";
        }
        .gemini-copy-icon:hover {
            opacity: 1.0;
            transform: scale(1.2);
            filter: drop-shadow(0 0 1px rgba(0,0,0,0.2));
        }

        /* Duży przycisk - Pozycjonowany "nad" tabelą */
        .gemini-ghost-btn {
            float: right;
            margin-top: 10px;
            margin-right: 10px;
            margin-bottom: -40px;
            position: relative;
            z-index: 999;
            font-size: 11px;
            font-family: Arial, sans-serif;
            cursor: pointer;
            color: #fff;
            background-color: #28a745;
            padding: 4px 12px;
            border-radius: 4px;
            border: 1px solid #218838;
            font-weight: bold;
            box-shadow: 0 2px 4px rgba(0,0,0,0.15);
        }
        .gemini-ghost-btn:hover {
            background-color: #218838;
        }
        .gemini-btn-text::after {
            content: "📋 Kopiuj dane";
        }

        /* Powiadomienia */
        .gemini-toast {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 24px;
            background: #333;
            color: #fff;
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 99999;
            font-family: 'Segoe UI', Arial, sans-serif;
            font-size: 14px;
            opacity: 0;
            transition: opacity 0.3s;
            pointer-events: none;
        }
        .gemini-toast.show {
            opacity: 1;
        }
    `;

    // ================= NARZĘDZIA POMOCNICZE =================

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = STYLES;
        document.head.appendChild(style);
    }

    function showToast(text) {
        let toast = document.getElementById('gemini-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'gemini-toast';
            toast.className = 'gemini-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = text;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2000);
    }

    function cleanText(elementOrHtml) {
        let container;
        if (typeof elementOrHtml === 'string') {
            container = document.createElement('div');
            container.innerHTML = elementOrHtml;
        } else {
            container = elementOrHtml.cloneNode(true);
        }
        container.querySelectorAll('.gemini-copy-icon').forEach(el => el.remove());
        container.querySelectorAll('.gray').forEach(el => el.remove());

        let text = container.innerText || container.textContent;
        return text.replace(/^[:\s\xA0]+/, '').replace(/[:\s\xA0]+$/, '').trim();
    }

    function addIcon(target, textToCopy) {
        if (!textToCopy || textToCopy.length < 1) return;

        const icon = document.createElement('span');
        icon.className = 'gemini-copy-icon';
        icon.title = 'Kopiuj: ' + textToCopy;

        icon.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            GM_setClipboard(textToCopy);
            showToast('Skopiowano: ' + textToCopy);
        };
        target.appendChild(icon);
    }

    function addGhostButton(tableElement, getDataFn) {
        if (tableElement.previousElementSibling && tableElement.previousElementSibling.classList.contains('gemini-ghost-btn')) return;

        const btn = document.createElement('button');
        const span = document.createElement('span');
        span.className = 'gemini-btn-text';
        btn.appendChild(span);
        btn.className = 'gemini-ghost-btn';

        btn.onclick = (e) => {
            e.preventDefault();
            const data = getDataFn();
            if (data) {
                GM_setClipboard(data);
                showToast('Skopiowano całą sekcję!');
            } else {
                showToast('Brak danych do skopiowania');
            }
        };

        tableElement.parentNode.insertBefore(btn, tableElement);
    }

    // ================= LOGIKA GŁÓWNA =================

    function processStandardSection(headerText) {
        const h2s = Array.from(document.querySelectorAll('h2'));
        const header = h2s.find(h => h.textContent.includes(headerText));
        if (!header) return;

        const table = header.nextElementSibling;
        if (!table || table.tagName !== 'TABLE') return;

        let sectionLines = [];

        table.querySelectorAll('tr').forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 2) return;

            const labelCell = cells[0];
            const valueCell = cells[1];
            const labelText = labelCell.textContent.toLowerCase();

            // Specjalna obsługa wiersza z adresem (rozbijanie na linie)
            if (labelText.includes('adres')) {
                // Pobieramy oryginalny HTML i dzielimy go po <br>
                const rawParts = valueCell.innerHTML.split(/<br\s*\/?>/i);

                // Czyścimy komórkę, żeby zbudować ją od nowa z ikonkami przy każdej linii
                valueCell.innerHTML = '';

                rawParts.forEach((part, index) => {
                    const cleanVal = cleanText(part);

                    // Tworzymy kontener dla pojedynczej linii (żeby ikonka była obok tekstu)
                    const lineSpan = document.createElement('span');
                    lineSpan.innerHTML = part; // Wstawiamy oryginalną treść (etykiety itp.)

                    if (cleanVal) {
                        sectionLines.push(cleanVal);
                        addIcon(lineSpan, cleanVal); // Dodajemy ikonkę do tej konkretnej linii
                    }

                    valueCell.appendChild(lineSpan);

                    // Przywracamy <br>, jeśli to nie była ostatnia linia
                    if (index < rawParts.length - 1) {
                        valueCell.appendChild(document.createElement('br'));
                    }
                });

            } else {
                // Standardowe pola (Imię, E-mail itp.)
                const val = cleanText(valueCell);
                if (val) {
                    sectionLines.push(val);
                    addIcon(valueCell, val);
                }
            }
        });

        addGhostButton(table, () => sectionLines.join('\n'));
    }

    function processPickupSection() {
        const h2s = Array.from(document.querySelectorAll('h2'));
        const header = h2s.find(h => h.textContent.includes('Zamawianie kuriera'));
        if (!header) return;

        const table = header.nextElementSibling;
        if (!table || table.tagName !== 'TABLE') return;

        let sectionLines = [];
        const rows = Array.from(table.querySelectorAll('tr'));
        const customRow = rows.find(r => r.textContent.includes('Niestandardowy adres'));

        if (customRow) {
            const valueCell = customRow.querySelectorAll('td')[1];
            if (valueCell) {
                // Ta sama logika rozbijania dla sekcji Pickup
                const rawParts = valueCell.innerHTML.split(/<br\s*\/?>/i);
                valueCell.innerHTML = '';

                rawParts.forEach((part, index) => {
                    const cleanVal = cleanText(part);
                    const lineSpan = document.createElement('span');
                    lineSpan.innerHTML = part;

                    if (cleanVal) {
                        sectionLines.push(cleanVal);
                        addIcon(lineSpan, cleanVal);
                    }

                    valueCell.appendChild(lineSpan);

                    if (index < rawParts.length - 1) {
                        valueCell.appendChild(document.createElement('br'));
                    }
                });
            }
        }

        addGhostButton(table, () => sectionLines.join('\n'));
    }

    // ================= URUCHOMIENIE =================

    function init() {
        injectStyles();
        processStandardSection('Dane nadawcy');
        processStandardSection('Dane adresata');
        processPickupSection();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();