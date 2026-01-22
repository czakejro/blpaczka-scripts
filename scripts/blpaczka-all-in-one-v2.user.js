// ==UserScript==
// @name         BLPaczka - All In One v2.0 (Zoptymalizowany)
// @namespace    http://tampermonkey.net/
// @version      2.4.2
// @description  Kompletny zestaw narzędzi: Tryb ciemny, Szybkie wyszukiwanie, Ochrona przed blokadą, Licznik czasu, Kopiowanie danych, Narzędzia API, Ulepszona lista, Podgląd XLSX, Panel ustawień.
// @author       Gemini & User & Claude
// @match        *://*.blpaczka.com/*
// @match        https://api.blpaczka.com/*
// @match        https://send.blpaczka.com/*
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// @connect      api.blpaczka.com
// @connect      send.blpaczka.com
// ==/UserScript==

(function() {
    'use strict';

    // ================= KONFIGURACJA =================
    const CONFIG = {
        // Domyślne ustawienia (można zmienić w panelu)
        defaults: {
            darkMode: false,
            clearDateFrom: true,
            showLoadTimer: true,
            itemsPerPage: 20,
            fetchDelayMs: 250,
            searchPanelPosition: 'top-right', // top-right, top-left
            enableKeyboardShortcuts: true,
            autoCollapseSearchPanel: false
        },

        // Stałe systemowe
        selectors: {
            mainTable: '#site_index_table table',
            indexTable: '#site_index_table',
            recordsCount: '.recordsCount strong',
            navTitle: '#box_options_nav_title',
            apiHistory: '#api_history, #xml_history',
            paginatorBox: '.paginator_box'
        },

        // Wersja dla cache-busting
        version: '2.4.2'
    };

    // ================= STORAGE HELPER =================
    const Storage = {
        get(key, defaultValue = null) {
            try {
                if (typeof GM_getValue !== 'undefined') {
                    const val = GM_getValue(key, null);
                    return val !== null ? val : defaultValue;
                }
                const stored = localStorage.getItem(`blp_${key}`);
                return stored !== null ? JSON.parse(stored) : defaultValue;
            } catch (e) {
                console.warn('BLPaczka Storage.get error:', e);
                return defaultValue;
            }
        },

        set(key, value) {
            try {
                if (typeof GM_setValue !== 'undefined') {
                    GM_setValue(key, value);
                } else {
                    localStorage.setItem(`blp_${key}`, JSON.stringify(value));
                }
            } catch (e) {
                console.warn('BLPaczka Storage.set error:', e);
            }
        },

        getConfig(key) {
            return this.get(`config_${key}`, CONFIG.defaults[key]);
        },

        setConfig(key, value) {
            this.set(`config_${key}`, value);
        }
    };

    // ================= UTILITY FUNCTIONS =================
    const Utils = {
        // Debounce - zapobiega wielokrotnym wywołaniom
        debounce(func, wait = 300) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        },

        // Throttle - ogranicza częstotliwość wywołań
        throttle(func, limit = 300) {
            let inThrottle;
            return function(...args) {
                if (!inThrottle) {
                    func.apply(this, args);
                    inThrottle = true;
                    setTimeout(() => inThrottle = false, limit);
                }
            };
        },

        // Bezpieczne escape HTML
        escapeHtml(unsafe) {
            if (typeof unsafe !== 'string') return '';
            const div = document.createElement('div');
            div.textContent = unsafe;
            return div.innerHTML;
        },

        // Bezpieczny querySelector z fallback
        $(selector, context = document) {
            try {
                return context.querySelector(selector);
            } catch (e) {
                console.warn('BLPaczka selector error:', selector, e);
                return null;
            }
        },

        // Bezpieczny querySelectorAll z fallback
        $$(selector, context = document) {
            try {
                return Array.from(context.querySelectorAll(selector));
            } catch (e) {
                console.warn('BLPaczka selector error:', selector, e);
                return [];
            }
        },

        // Fallback dla :has() selector
        filterRowsWithTd(rows) {
            return rows.filter(row => row.querySelector('td') !== null);
        },

        // Bezpieczne pobieranie tekstu
        getTextContent(element, defaultValue = '') {
            if (!element) return defaultValue;
            return (element.textContent || '').trim() || defaultValue;
        },

        // Tworzenie elementu z atrybutami
        createElement(tag, attributes = {}, children = []) {
            const el = document.createElement(tag);
            Object.entries(attributes).forEach(([key, value]) => {
                if (key === 'style' && typeof value === 'object') {
                    Object.assign(el.style, value);
                } else if (key === 'className') {
                    el.className = value;
                } else if (key === 'innerHTML') {
                    el.innerHTML = value;
                } else if (key === 'textContent') {
                    el.textContent = value;
                } else if (key.startsWith('on') && typeof value === 'function') {
                    el.addEventListener(key.slice(2).toLowerCase(), value);
                } else {
                    el.setAttribute(key, value);
                }
            });
            children.forEach(child => {
                if (typeof child === 'string') {
                    el.appendChild(document.createTextNode(child));
                } else if (child instanceof Node) {
                    el.appendChild(child);
                }
            });
            return el;
        },

        // Opóźnienie (Promise-based)
        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        },

        // Normalizacja nagłówków (dla XLSX)
        normalizeHeader(str) {
            if (typeof str !== 'string') str = String(str || '');
            return str
                .toLowerCase()
                .replace(/\s+/g, ' ')
                .replace(/[ąàáäâãåæ]/g, 'a')
                .replace(/[ćçč]/g, 'c')
                .replace(/[ęèéëê]/g, 'e')
                .replace(/[ł]/g, 'l')
                .replace(/[ńñ]/g, 'n')
                .replace(/[óöòôõø]/g, 'o')
                .replace(/[śşš]/g, 's')
                .replace(/[źżž]/g, 'z')
                .replace(/[üúùû]/g, 'u')
                .replace(/[ýÿ]/g, 'y')
                .replace(/['']/g, '')
                .trim();
        },

        // Format XML z wcięciami
        formatXml(xml) {
            if (!xml || typeof xml !== 'string') return '';
            const tab = '  ';
            let formatted = '';
            let indent = '';

            const xmlClean = xml.replace(/>\s*</g, '><').trim();
            const nodes = xmlClean.split(/(?=<)|(?<=>)/);

            nodes.forEach(node => {
                if (!node.trim()) return;

                const isClosingTag = /^<\//.test(node);
                const isSelfClosing = /\/>$/.test(node);
                const isOpeningTag = /^<[^\/]/.test(node) && !isSelfClosing;
                const isDeclaration = /^<\?/.test(node);

                if (isClosingTag) {
                    indent = indent.substring(tab.length);
                }

                if (node.startsWith('<')) {
                    formatted += indent + node + '\n';
                }

                if (isOpeningTag && !isDeclaration) {
                    indent += tab;
                }
            });

            return formatted.trim();
        }
    };

    // ================= HTTP CLIENT =================
    const Http = {
        // Uniwersalna metoda fetch z obsługą błędów
        async fetch(url, options = {}) {
            const { timeout = 30000, ...fetchOptions } = options;

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeout);

                const response = await fetch(url, {
                    ...fetchOptions,
                    signal: controller.signal,
                    credentials: 'include'
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                return response;
            } catch (error) {
                if (error.name === 'AbortError') {
                    throw new Error('Przekroczono limit czasu żądania');
                }
                throw error;
            }
        },

        // GM_xmlhttpRequest wrapper z Promise
        gmFetch(url, options = {}) {
            return new Promise((resolve, reject) => {
                if (typeof GM_xmlhttpRequest === 'undefined') {
                    reject(new Error('GM_xmlhttpRequest niedostępne'));
                    return;
                }

                GM_xmlhttpRequest({
                    method: options.method || 'GET',
                    url: url,
                    responseType: options.responseType || 'text',
                    anonymous: false,
                    withCredentials: true,
                    timeout: options.timeout || 30000,
                    onload: (response) => {
                        if (response.status >= 200 && response.status < 300) {
                            resolve(response);
                        } else {
                            reject(new Error(`HTTP ${response.status}`));
                        }
                    },
                    onerror: () => reject(new Error('Błąd sieci')),
                    ontimeout: () => reject(new Error('Przekroczono limit czasu'))
                });
            });
        }
    };

    // ================= UI COMPONENTS =================
    const UI = {
        // Wyświetl powiadomienie toast
        showToast(message, type = 'success', duration = 3000) {
            const existingToasts = Utils.$$('.blp-toast');
            existingToasts.forEach((t, i) => {
                t.style.top = `${20 + (i + 1) * 60}px`;
            });

            const toast = Utils.createElement('div', {
                className: `blp-toast blp-toast-${type}`,
                textContent: message,
                style: {
                    position: 'fixed',
                    top: '20px',
                    right: '20px',
                    padding: '12px 20px',
                    borderRadius: '6px',
                    color: '#fff',
                    fontWeight: '500',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                    zIndex: '99999',
                    animation: 'blpFadeIn 0.3s ease',
                    maxWidth: '350px'
                }
            });

            // Kolory w zależności od typu
            const colors = {
                success: '#28a745',
                error: '#dc3545',
                warning: '#ffc107',
                info: '#17a2b8'
            };
            toast.style.backgroundColor = colors[type] || colors.success;
            if (type === 'warning') toast.style.color = '#212529';

            document.body.appendChild(toast);

            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(100px)';
                toast.style.transition = 'all 0.3s ease';
                setTimeout(() => toast.remove(), 300);
            }, duration);
        },

        // Modal uniwersalny
        showModal(content, options = {}) {
            const {
                title = '',
                showClose = true,
                showBack = false,
                onBack = null,
                width = '600px'
            } = options;

            // Usuń istniejący modal
            const existing = Utils.$('#blp-modal');
            if (existing) existing.remove();

            const backdrop = Utils.createElement('div', {
                id: 'blp-modal',
                style: {
                    position: 'fixed',
                    top: '0',
                    left: '0',
                    width: '100%',
                    height: '100%',
                    backgroundColor: 'rgba(0, 0, 0, 0.6)',
                    zIndex: '99998',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    animation: 'blpFadeIn 0.2s ease'
                },
                onClick: (e) => {
                    if (e.target === backdrop) backdrop.remove();
                }
            });

            const modal = Utils.createElement('div', {
                className: 'blp-modal-window',
                style: {
                    background: '#fff',
                    borderRadius: '8px',
                    padding: '0',
                    minWidth: width,
                    maxWidth: '90vw',
                    maxHeight: '85vh',
                    overflow: 'hidden',
                    boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
                    display: 'flex',
                    flexDirection: 'column'
                }
            });

            // Header
            if (title) {
                const header = Utils.createElement('div', {
                    style: {
                        padding: '15px 20px',
                        borderBottom: '1px solid #eee',
                        background: '#f8f9fa',
                        fontWeight: '600',
                        fontSize: '16px'
                    },
                    innerHTML: title
                });
                modal.appendChild(header);
            }

            // Content
            const contentDiv = Utils.createElement('div', {
                style: {
                    padding: '20px',
                    overflowY: 'auto',
                    flex: '1'
                }
            });

            if (typeof content === 'string') {
                contentDiv.innerHTML = content;
            } else if (content instanceof Node) {
                contentDiv.appendChild(content);
            }
            modal.appendChild(contentDiv);

            // Footer
            const footer = Utils.createElement('div', {
                style: {
                    padding: '15px 20px',
                    borderTop: '1px solid #eee',
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: '10px',
                    background: '#f8f9fa'
                }
            });

            if (showBack && onBack) {
                footer.appendChild(Utils.createElement('button', {
                    className: 'blp-btn blp-btn-secondary',
                    textContent: '← Wróć',
                    onClick: onBack
                }));
            }

            if (showClose) {
                footer.appendChild(Utils.createElement('button', {
                    className: 'blp-btn',
                    textContent: 'Zamknij',
                    onClick: () => backdrop.remove()
                }));
            }

            modal.appendChild(footer);
            backdrop.appendChild(modal);
            document.body.appendChild(backdrop);

            return backdrop;
        },

        // Tworzenie przycisku
        createButton(text, options = {}) {
            const {
                className = '',
                variant = 'primary',
                size = 'normal',
                icon = '',
                onClick = null
            } = options;

            const variants = {
                primary: 'blp-btn-primary',
                secondary: 'blp-btn-secondary',
                success: 'blp-btn-success',
                warning: 'blp-btn-warning',
                danger: 'blp-btn-danger',
                info: 'blp-btn-info'
            };

            const btn = Utils.createElement('button', {
                className: `blp-btn ${variants[variant] || ''} ${className}`.trim(),
                innerHTML: icon ? `${icon} ${text}` : text,
                type: 'button'
            });

            if (size === 'small') {
                btn.style.padding = '4px 10px';
                btn.style.fontSize = '12px';
            }

            if (onClick) {
                btn.addEventListener('click', onClick);
            }

            return btn;
        }
    };

    // ================= GLOBALNE STYLE =================
    const STYLES = `
        /* Animacje */
        @keyframes blpFadeIn {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        @keyframes blpSpin {
            to { transform: rotate(360deg); }
        }

        /* Przyciski */
        .blp-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 8px 16px;
            font-size: 13px;
            font-weight: 600;
            border-radius: 6px;
            border: none;
            cursor: pointer;
            transition: all 0.2s ease;
            text-decoration: none !important;
            color: #fff !important;
            background: #198754;
            line-height: 1.4;
        }

        .blp-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        }

        .blp-btn:active {
            transform: translateY(0);
        }

        .blp-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none !important;
        }

        .blp-btn-primary { background: #007bff; }
        .blp-btn-primary:hover { background: #0056b3; }

        .blp-btn-secondary { background: #6c757d; }
        .blp-btn-secondary:hover { background: #545b62; }

        .blp-btn-success { background: #28a745; }
        .blp-btn-success:hover { background: #1e7e34; }

        .blp-btn-warning { background: #ffc107; color: #212529 !important; }
        .blp-btn-warning:hover { background: #d39e00; }

        .blp-btn-danger { background: #dc3545; }
        .blp-btn-danger:hover { background: #bd2130; }

        .blp-btn-info { background: #17a2b8; }
        .blp-btn-info:hover { background: #138496; }

        /* Panel wyszukiwania */
        #blp-search-panel {
            position: fixed;
            top: 10px;
            right: 20px;
            z-index: 9999;
            background: linear-gradient(135deg, #fff 0%, #f8f9fa 100%);
            padding: 15px;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15);
            border: 1px solid #e0e0e0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            min-width: 320px;
            transition: all 0.3s ease;
        }

        #blp-search-panel.collapsed {
            min-width: auto;
            padding: 10px 15px;
        }

        #blp-search-panel.collapsed .blp-search-content {
            display: none;
        }

        .blp-search-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
            padding-bottom: 10px;
            border-bottom: 1px solid #eee;
        }

        #blp-search-panel.collapsed .blp-search-header {
            margin-bottom: 0;
            padding-bottom: 0;
            border-bottom: none;
        }

        .blp-search-header span {
            font-size: 12px;
            font-weight: 600;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .blp-search-toggle {
            cursor: pointer;
            font-size: 14px;
            color: #666;
            transition: transform 0.3s ease;
            user-select: none;
            padding: 4px;
        }

        .blp-search-toggle:hover {
            color: #333;
        }

        #blp-search-panel.collapsed .blp-search-toggle {
            transform: rotate(-90deg);
        }

        .blp-search-row {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 10px;
        }

        .blp-search-row:last-child {
            margin-bottom: 0;
        }

        .blp-search-label {
            font-size: 13px;
            color: #555;
            font-weight: 600;
            min-width: 90px;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .blp-search-input {
            flex: 1;
            padding: 10px 12px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 14px;
            outline: none;
            transition: all 0.2s ease;
            background: #fff;
        }

        .blp-search-input:focus {
            border-color: #007bff;
            box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.15);
        }

        .blp-search-input::placeholder {
            color: #aaa;
            font-size: 12px;
        }

        .blp-search-input.error {
            border-color: #dc3545;
            animation: blpShake 0.5s ease;
        }

        @keyframes blpShake {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-5px); }
            75% { transform: translateX(5px); }
        }

        .blp-search-hint {
            font-size: 11px;
            color: #888;
            margin-top: 8px;
            padding-left: 100px;
            line-height: 1.4;
        }

        .blp-search-btn {
            padding: 10px 16px !important;
            border-radius: 8px !important;
            font-size: 13px !important;
            min-width: 70px;
        }

        /* Licznik czasu */
        #blp-load-timer {
            position: fixed;
            bottom: 20px;
            left: 20px;
            background: rgba(0, 0, 0, 0.8);
            color: #fff;
            padding: 8px 14px;
            border-radius: 20px;
            font-family: 'Monaco', 'Consolas', monospace;
            font-size: 12px;
            z-index: 9999;
            pointer-events: none;
            opacity: 0;
            transform: translateY(20px);
            transition: all 0.3s ease;
        }

        #blp-load-timer.visible {
            opacity: 1;
            transform: translateY(0);
        }

        /* Ikona kopiowania */
        .blp-copy-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            margin-left: 8px;
            font-size: 14px;
            opacity: 0.5;
            transition: all 0.2s ease;
            padding: 4px;
            border-radius: 4px;
            user-select: none;
            -webkit-user-select: none;
            -ms-user-select: none;
            -moz-user-select: none;
        }

        .blp-copy-icon:hover {
            opacity: 1;
            background: rgba(0,0,0,0.05);
            transform: scale(1.1);
        }

        /* Tabela - ulepszenia */
        #site_index_table table tr.blp-highlight {
            background: #fff3cd !important;
        }

        #site_index_table table tr.blp-filtered-out {
            display: none !important;
        }

        /* Floating button */
        .blp-floating-btn {
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 56px;
            height: 56px;
            border-radius: 50%;
            background: linear-gradient(135deg, #007bff 0%, #0056b3 100%);
            color: #fff;
            border: none;
            font-size: 24px;
            cursor: pointer;
            box-shadow: 0 4px 15px rgba(0, 123, 255, 0.4);
            z-index: 9998;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s ease;
        }

        .blp-floating-btn:hover {
            transform: scale(1.1);
            box-shadow: 0 6px 20px rgba(0, 123, 255, 0.5);
        }

        /* Kontrolki listy */
        #blp-list-controls {
            display: flex;
            flex-wrap: wrap;
            justify-content: space-between;
            align-items: center;
            padding: 12px 15px;
            background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
            border-radius: 8px;
            margin: 10px 0;
            gap: 10px;
        }

        #blp-list-controls .blp-controls-group {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: center;
        }

        #blp-visible-count {
            font-size: 13px;
            color: #666;
            margin-left: 15px;
        }

        /* Link w tabeli XLSX */
        .blp-xlsx-link {
            color: #0d6efd;
            text-decoration: underline;
            font-weight: 600;
            cursor: pointer;
        }

        .blp-xlsx-link:hover {
            color: #0a58ca;
        }

        /* Ikona faktury */
        .blp-invoice-icon {
            display: inline-flex;
            margin-left: 5px;
            opacity: 0.7;
            transition: opacity 0.2s;
        }

        .blp-invoice-icon:hover {
            opacity: 1;
        }

        /* Settings panel */
        .blp-settings-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
        }

        .blp-settings-item {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .blp-settings-item label {
            font-size: 13px;
            color: #333;
            cursor: pointer;
        }

        .blp-settings-item input[type="checkbox"] {
            width: 18px;
            height: 18px;
            cursor: pointer;
        }

        /* Modal pre */
        .blp-modal-pre {
            white-space: pre-wrap;
            word-break: break-all;
            background: #f5f5f5;
            padding: 15px;
            border-radius: 6px;
            border: 1px solid #ddd;
            font-family: 'Monaco', 'Consolas', monospace;
            font-size: 12px;
            max-height: 400px;
            overflow-y: auto;
        }

        /* Responsywność */
        @media (max-width: 1200px) {
            #blp-search-panel {
                right: 10px;
                min-width: 280px;
            }
        }

        @media (max-width: 768px) {
            #blp-search-panel {
                top: auto;
                bottom: 80px;
                right: 10px;
                left: 10px;
                min-width: auto;
            }

            .blp-search-row {
                flex-wrap: wrap;
            }

            .blp-search-label {
                min-width: 100%;
            }

            .blp-search-hint {
                padding-left: 0;
            }
        }

        /* ================= DARK MODE ================= */
        html.blp-dark-mode,
        body.blp-dark-mode {
            background: #1e1e1e !important;
            background-color: #1e1e1e !important;
            background-image: none !important;
            color: #d4d4d4 !important;
        }

        /* Nadpisanie wszelkich obrazków/gradientów w tle */
        .blp-dark-mode::before,
        .blp-dark-mode::after,
        .blp-dark-mode body::before,
        .blp-dark-mode body::after {
            display: none !important;
            background: none !important;
        }

        /* Upewnij się że całe tło jest ciemne */
        .blp-dark-mode * {
            border-color: #404040;
        }

        /* Header */
        .blp-dark-mode #header {
            background: #1e1e1e !important;
            background-color: #1e1e1e !important;
            background-image: none !important;
            border-bottom: 1px solid #404040 !important;
        }

        .blp-dark-mode #header *,
        .blp-dark-mode #header::before,
        .blp-dark-mode #header::after {
            background-image: none !important;
        }

        .blp-dark-mode #header_left {
            background: transparent !important;
            background-image: none !important;
        }

        .blp-dark-mode #header_right,
        .blp-dark-mode #header_right a {
            color: #b0b0b0 !important;
        }

        .blp-dark-mode #header_right a:hover {
            color: #fff !important;
        }

        .blp-dark-mode #header_left img {
            background: transparent !important;
        }

        /* Menu boczne */
        .blp-dark-mode .content_menu,
        .blp-dark-mode #cssmenu,
        .blp-dark-mode #cssmenu > ul,
        .blp-dark-mode #cssmenu > ul > li {
            background-color: #252525 !important;
            background: #252525 !important;
        }

        .blp-dark-mode #cssmenu ul li a,
        .blp-dark-mode #cssmenu > ul > li > a,
        .blp-dark-mode #cssmenu > ul > li > a span {
            color: #c0c0c0 !important;
            background-color: transparent !important;
            background: transparent !important;
        }

        .blp-dark-mode #cssmenu ul li a:hover,
        .blp-dark-mode #cssmenu ul li a.selected,
        .blp-dark-mode #cssmenu > ul > li:hover > a,
        .blp-dark-mode #cssmenu > ul > li.active > a {
            background-color: #333 !important;
            background: #333 !important;
            color: #fff !important;
        }

        .blp-dark-mode #cssmenu ul li a:hover span,
        .blp-dark-mode #cssmenu ul li a.selected span {
            color: #fff !important;
        }

        .blp-dark-mode #cssmenu ul ul,
        .blp-dark-mode #cssmenu > ul > li > ul {
            background-color: #2a2a2a !important;
            background: #2a2a2a !important;
            border: 1px solid #404040 !important;
        }

        .blp-dark-mode #cssmenu ul ul li,
        .blp-dark-mode #cssmenu ul ul li a {
            background-color: #2a2a2a !important;
            background: #2a2a2a !important;
            border-bottom: 1px solid #353535 !important;
        }

        .blp-dark-mode #cssmenu ul ul li a:hover {
            background-color: #383838 !important;
            background: #383838 !important;
        }

        /* Content box */
        .blp-dark-mode #content,
        .blp-dark-mode #content_960,
        .blp-dark-mode #content_box {
            background-color: #1e1e1e !important;
        }

        /* Tabs */
        .blp-dark-mode .tabs,
        .blp-dark-mode #box_options_nav_title_2 {
            background-color: #2d2d2d !important;
        }

        .blp-dark-mode .tabs a,
        .blp-dark-mode #box_options_nav_title_2 a {
            color: #b0b0b0 !important;
        }

        .blp-dark-mode .tabs .selected,
        .blp-dark-mode #box_options_nav_title_2.selected {
            background-color: #404040 !important;
        }

        .blp-dark-mode .tabs .selected a {
            color: #fff !important;
        }

        /* Tabele */
        .blp-dark-mode table,
        .blp-dark-mode table.view {
            background-color: #252525 !important;
            border-color: #404040 !important;
        }

        .blp-dark-mode table tr,
        .blp-dark-mode table.view tr {
            background-color: #252525 !important;
            border-bottom: 1px solid #353535 !important;
        }

        .blp-dark-mode table tr:nth-child(even),
        .blp-dark-mode table.view tr:nth-child(even) {
            background-color: #2a2a2a !important;
        }

        .blp-dark-mode table tr:hover {
            background-color: #333 !important;
        }

        .blp-dark-mode table th {
            background-color: #333 !important;
            color: #e0e0e0 !important;
            border-bottom: 2px solid #505050 !important;
        }

        .blp-dark-mode table td {
            color: #d0d0d0 !important;
            border-color: #353535 !important;
        }

        .blp-dark-mode table td:first-child {
            background-color: #2d2d2d !important;
            color: #a0a0a0 !important;
        }

        /* Linki */
        .blp-dark-mode a {
            color: #6db3f2 !important;
        }

        .blp-dark-mode a:hover {
            color: #9dcfff !important;
        }

        /* Formularze */
        .blp-dark-mode #box_options,
        .blp-dark-mode #box_options_filtr_Article,
        .blp-dark-mode #box_options_right,
        .blp-dark-mode #box_options_left,
        .blp-dark-mode #box_options_bottom {
            background-color: #2a2a2a !important;
            border-color: #404040 !important;
        }

        .blp-dark-mode input[type="text"],
        .blp-dark-mode input[type="password"],
        .blp-dark-mode input[type="email"],
        .blp-dark-mode input[type="number"],
        .blp-dark-mode textarea,
        .blp-dark-mode select {
            background-color: #333 !important;
            border: 1px solid #505050 !important;
            color: #e0e0e0 !important;
        }

        .blp-dark-mode input[type="text"]:focus,
        .blp-dark-mode select:focus,
        .blp-dark-mode textarea:focus {
            border-color: #6db3f2 !important;
            outline: none !important;
        }

        .blp-dark-mode label {
            color: #b0b0b0 !important;
        }

        /* Przyciski */
        .blp-dark-mode input[type="submit"],
        .blp-dark-mode button {
            background-color: #404040 !important;
            color: #e0e0e0 !important;
            border: 1px solid #505050 !important;
        }

        .blp-dark-mode input[type="submit"]:hover,
        .blp-dark-mode button:hover {
            background-color: #505050 !important;
        }

        /* Nagłówki sekcji */
        .blp-dark-mode h2,
        .blp-dark-mode h3 {
            color: #e0e0e0 !important;
        }

        .blp-dark-mode #box_options_nav_title {
            background-color: #333 !important;
            color: #e0e0e0 !important;
        }

        /* Notices i alerty */
        .blp-dark-mode .notice,
        .blp-dark-mode span.notice {
            background-color: #3d3520 !important;
            border-color: #5a4a20 !important;
            color: #e0c060 !important;
        }

        /* Gray spans */
        .blp-dark-mode .gray,
        .blp-dark-mode .grey,
        .blp-dark-mode span.gray,
        .blp-dark-mode span.grey {
            color: #808080 !important;
        }

        /* Green/Red status */
        .blp-dark-mode .green,
        .blp-dark-mode span.green {
            color: #5cb85c !important;
        }

        .blp-dark-mode .red,
        .blp-dark-mode span.red {
            color: #d9534f !important;
        }

        /* Paginator */
        .blp-dark-mode .paginator_box {
            background-color: #2a2a2a !important;
        }

        .blp-dark-mode .paginator_box a {
            color: #6db3f2 !important;
        }

        .blp-dark-mode .paginator_box .current {
            background-color: #404040 !important;
            color: #fff !important;
        }

        /* Footer */
        .blp-dark-mode #footer {
            background-color: #1a1a1a !important;
            border-top: 1px solid #333 !important;
            color: #707070 !important;
        }

        .blp-dark-mode #footer_content3 {
            background-color: #1a1a1a !important;
        }

        /* Site index table */
        .blp-dark-mode #site_index_table {
            background-color: #252525 !important;
            border-color: #404040 !important;
        }

        /* Records count */
        .blp-dark-mode .recordsCount {
            color: #a0a0a0 !important;
        }

        /* Kolorowe przyciski akcji - zachowaj kolory ale przyciemnij */
        .blp-dark-mode a[style*="background"],
        .blp-dark-mode .btn,
        .blp-dark-mode .button {
            filter: brightness(0.85) !important;
        }

        /* Ikonki akcji - inwertuj lub przyciemnij */
        .blp-dark-mode .contentEdit,
        .blp-dark-mode .contentDelete,
        .blp-dark-mode .contentPreview,
        .blp-dark-mode .contentDownload,
        .blp-dark-mode .contentMoney,
        .blp-dark-mode .contentAttach,
        .blp-dark-mode .contentPublish,
        .blp-dark-mode .contentCancel,
        .blp-dark-mode .contentNumber,
        .blp-dark-mode .contentCost,
        .blp-dark-mode .contentOrders,
        .blp-dark-mode .contentPackages,
        .blp-dark-mode .contentList {
            filter: brightness(1.1) saturate(0.9) !important;
        }

        /* Zakładka Paczki (aktywna) */
        .blp-dark-mode .tabs div[id*="nav_title"],
        .blp-dark-mode div[id*="box_options_nav_title"] {
            background-color: #2d2d2d !important;
        }

        /* Górny pasek z przyciskami (Wczytaj wszystko, Wszystkie, etc) */
        .blp-dark-mode div[style*="background"] {
            background-color: #2a2a2a !important;
        }

        /* Separator "Klient" */
        .blp-dark-mode fieldset,
        .blp-dark-mode legend {
            border-color: #404040 !important;
            color: #a0a0a0 !important;
        }

        /* Tekst w tabelach - upewnij się że jest widoczny */
        .blp-dark-mode #site_index_table td,
        .blp-dark-mode #site_index_table td a,
        .blp-dark-mode #site_index_table td span {
            color: #d0d0d0 !important;
        }

        .blp-dark-mode #site_index_table td a {
            color: #6db3f2 !important;
        }

        .blp-dark-mode #site_index_table td a:hover {
            color: #9dcfff !important;
        }

        /* Rating / Cena przesyłki - tabela z cenami */
        .blp-dark-mode .rating,
        .blp-dark-mode .rating table,
        .blp-dark-mode .rating table tr,
        .blp-dark-mode .rating table td,
        .blp-dark-mode .rating table th {
            background-color: #2a2a2a !important;
            background: #2a2a2a !important;
            color: #d0d0d0 !important;
        }

        .blp-dark-mode .rating table td:first-child,
        .blp-dark-mode .rating .rating_title {
            background-color: #252525 !important;
            background: #252525 !important;
        }

        .blp-dark-mode .rating .rating_price,
        .blp-dark-mode .rating table td:last-child {
            background-color: #2d2d2d !important;
            background: #2d2d2d !important;
        }

        /* Tabele wewnątrz view */
        .blp-dark-mode table.view table,
        .blp-dark-mode table.view table tr,
        .blp-dark-mode table.view table td,
        .blp-dark-mode table.view table th {
            background-color: #2a2a2a !important;
            background: #2a2a2a !important;
            color: #d0d0d0 !important;
            border-color: #404040 !important;
        }

        /* Wszystkie tabele wewnętrzne */
        .blp-dark-mode td table,
        .blp-dark-mode td table tr,
        .blp-dark-mode td table td {
            background-color: #2a2a2a !important;
            background: #2a2a2a !important;
        }

        /* Big/strong w cenach */
        .blp-dark-mode big,
        .blp-dark-mode big strong,
        .blp-dark-mode .rating big,
        .blp-dark-mode .rating strong {
            color: #e0e0e0 !important;
        }

        /* H2, H3 w sekcjach */
        .blp-dark-mode td h2,
        .blp-dark-mode td h3,
        .blp-dark-mode .rating h2,
        .blp-dark-mode .rating h3 {
            color: #e0e0e0 !important;
        }

        /* Logo w headerze - rozjaśnij jeśli ciemne */
        .blp-dark-mode #header_left img {
            filter: brightness(1.2) !important;
            background: transparent !important;
        }

        /* Scrollbary */
        .blp-dark-mode ::-webkit-scrollbar {
            width: 10px;
            height: 10px;
        }

        .blp-dark-mode ::-webkit-scrollbar-track {
            background: #1e1e1e;
        }

        .blp-dark-mode ::-webkit-scrollbar-thumb {
            background: #404040;
            border-radius: 5px;
        }

        .blp-dark-mode ::-webkit-scrollbar-thumb:hover {
            background: #505050;
        }

        /* Box nav */
        .blp-dark-mode #box_options_nav {
            background-color: #2a2a2a !important;
        }

        .blp-dark-mode #box_options_nav_add a {
            background-color: #2e7d32 !important;
            color: #fff !important;
        }

        /* Rating section */
        .blp-dark-mode .rating {
            color: #a0a0a0 !important;
        }

        .blp-dark-mode .rating table td {
            background-color: #2a2a2a !important;
        }

        /* Content icons */
        .blp-dark-mode a.contentEdit,
        .blp-dark-mode a.contentDelete,
        .blp-dark-mode a.contentPreview,
        .blp-dark-mode a.contentDownload,
        .blp-dark-mode a.contentMoney,
        .blp-dark-mode a.contentAttach {
            filter: brightness(0.9) !important;
        }

        /* BLP elements w dark mode */
        .blp-dark-mode #blp-search-panel {
            background: linear-gradient(135deg, #2a2a2a 0%, #1e1e1e 100%) !important;
            border-color: #404040 !important;
        }

        .blp-dark-mode .blp-search-header {
            border-bottom-color: #404040 !important;
        }

        .blp-dark-mode .blp-search-header span,
        .blp-dark-mode .blp-search-label {
            color: #b0b0b0 !important;
        }

        .blp-dark-mode .blp-search-input {
            background-color: #333 !important;
            border-color: #505050 !important;
            color: #e0e0e0 !important;
        }

        .blp-dark-mode .blp-search-hint {
            color: #707070 !important;
        }

        .blp-dark-mode #blp-list-controls {
            background: linear-gradient(135deg, #2a2a2a 0%, #252525 100%) !important;
        }

        .blp-dark-mode .blp-modal-window {
            background: #2a2a2a !important;
            color: #d0d0d0 !important;
        }

        .blp-dark-mode .blp-modal-pre {
            background: #1e1e1e !important;
            border-color: #404040 !important;
            color: #d0d0d0 !important;
        }

        .blp-dark-mode .blp-settings-item label {
            color: #b0b0b0 !important;
        }

        /* Dark mode toggle button */
        #blp-dark-mode-toggle {
            position: fixed;
            bottom: 20px;
            left: 20px;
            width: 44px;
            height: 44px;
            border-radius: 50%;
            background: linear-gradient(135deg, #444 0%, #222 100%);
            border: 2px solid #555;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            z-index: 9998;
            transition: all 0.3s ease;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        }

        #blp-dark-mode-toggle:hover {
            transform: scale(1.1);
            box-shadow: 0 4px 15px rgba(0,0,0,0.4);
        }

        body:not(.blp-dark-mode) #blp-dark-mode-toggle {
            background: linear-gradient(135deg, #f0f0f0 0%, #ddd 100%);
            border-color: #ccc;
        }
    `;

    // ================= MODUŁ: STYLE INJECTION =================
    function injectStyles() {
        const style = document.createElement('style');
        style.id = 'blp-styles';
        style.textContent = STYLES;
        (document.head || document.documentElement).appendChild(style);
    }

    // ================= MODUŁ: PANEL WYSZUKIWANIA =================
    const SearchPanel = {
        init() {
            if (Utils.$('#blp-search-panel')) return;

            const panel = Utils.createElement('div', { id: 'blp-search-panel' });

            panel.innerHTML = `
                <div class="blp-search-header">
                    <span>🔍 Szybkie wyszukiwanie</span>
                    <span class="blp-search-toggle" id="blp-search-toggle" title="Zwiń/Rozwiń">▼</span>
                </div>
                <div class="blp-search-content">
                    <div class="blp-search-row">
                        <span class="blp-search-label">📦 Przesyłka:</span>
                        <input type="text" id="blp-waybill-input" class="blp-search-input"
                               placeholder="Nr listu przewozowego" maxlength="50" autocomplete="off">
                        <button id="blp-waybill-btn" class="blp-btn blp-btn-primary blp-search-btn">Szukaj</button>
                    </div>
                    <div class="blp-search-row">
                        <span class="blp-search-label">👤 Klient:</span>
                        <input type="text" id="blp-client-input" class="blp-search-input"
                               placeholder="ID / NIP / Tel / Email" maxlength="100" autocomplete="off">
                        <button id="blp-client-btn" class="blp-btn blp-btn-success blp-search-btn">Szukaj</button>
                    </div>
                    <div class="blp-search-hint">
                        💡 <strong>ID</strong> (max 5 cyfr) | <strong>NIP/Tel</strong> (więcej cyfr) | <strong>Email/Tekst</strong> (wyszukiwanie ogólne)
                    </div>
                </div>
            `;

            document.body.appendChild(panel);
            this.bindEvents();
            this.restoreState();
        },

        bindEvents() {
            // Toggle panel
            const toggle = Utils.$('#blp-search-toggle');
            if (toggle) {
                toggle.addEventListener('click', () => this.togglePanel());
            }

            // Wyszukiwanie przesyłki
            const waybillInput = Utils.$('#blp-waybill-input');
            const waybillBtn = Utils.$('#blp-waybill-btn');

            if (waybillBtn) {
                waybillBtn.addEventListener('click', () => this.searchWaybill());
            }
            if (waybillInput) {
                waybillInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') this.searchWaybill();
                });
            }

            // Wyszukiwanie klienta
            const clientInput = Utils.$('#blp-client-input');
            const clientBtn = Utils.$('#blp-client-btn');

            if (clientBtn) {
                clientBtn.addEventListener('click', () => this.searchClient());
            }
            if (clientInput) {
                clientInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') this.searchClient();
                });
            }

            // Skróty klawiaturowe
            if (Storage.getConfig('enableKeyboardShortcuts')) {
                document.addEventListener('keydown', (e) => {
                    // Ctrl+Shift+F - przesyłka
                    if (e.ctrlKey && e.shiftKey && e.key === 'F') {
                        e.preventDefault();
                        waybillInput?.focus();
                        waybillInput?.select();
                    }
                    // Ctrl+Shift+K - klient
                    if (e.ctrlKey && e.shiftKey && e.key === 'K') {
                        e.preventDefault();
                        clientInput?.focus();
                        clientInput?.select();
                    }
                    // Escape - zamknij panel
                    if (e.key === 'Escape') {
                        const panel = Utils.$('#blp-search-panel');
                        if (panel && !panel.classList.contains('collapsed')) {
                            this.togglePanel();
                        }
                    }
                });
            }
        },

        togglePanel() {
            const panel = Utils.$('#blp-search-panel');
            if (panel) {
                panel.classList.toggle('collapsed');
                Storage.set('searchPanelCollapsed', panel.classList.contains('collapsed'));
            }
        },

        restoreState() {
            const isCollapsed = Storage.get('searchPanelCollapsed', Storage.getConfig('autoCollapseSearchPanel'));
            const panel = Utils.$('#blp-search-panel');
            if (panel && isCollapsed) {
                panel.classList.add('collapsed');
            }
        },

        searchWaybill() {
            const input = Utils.$('#blp-waybill-input');
            if (!input) return;

            const value = input.value.trim();
            if (!value) {
                this.showInputError(input);
                return;
            }

            // Usuń spacje, myślniki, kropki
            const cleanValue = value.replace(/[\s\-\.]/g, '');
            Storage.set('lastWaybill', cleanValue);

            window.location.href = `https://api.blpaczka.com/admin/courier/orders/index/waybill_no:${cleanValue}/payed:1`;
        },

        searchClient() {
            const input = Utils.$('#blp-client-input');
            if (!input) return;

            const value = input.value.trim();
            if (!value) {
                this.showInputError(input);
                return;
            }

            Storage.set('lastClient', value);

            // Inteligentne wykrywanie typu wyszukiwania
            const isOnlyDigits = /^\d+$/.test(value);
            let searchUrl;

            if (isOnlyDigits && value.length <= 5) {
                // Max 5 cyfr = ID klienta
                searchUrl = `https://api.blpaczka.com/admin/klienci/user_id:${value}`;
            } else {
                // Więcej cyfr (NIP/Tel) lub email/tekst = string search
                const encodedValue = encodeURIComponent(value);
                searchUrl = `https://api.blpaczka.com/admin/klienci/string:${encodedValue}`;
            }

            window.location.href = searchUrl;
        },

        showInputError(input) {
            input.classList.add('error');
            const originalPlaceholder = input.placeholder;
            input.placeholder = '⚠️ Wpisz wartość!';

            setTimeout(() => {
                input.classList.remove('error');
                input.placeholder = originalPlaceholder;
            }, 2000);
        }
    };

    // ================= MODUŁ: LICZNIK CZASU ŁADOWANIA =================
    const LoadTimer = {
        init() {
            if (!Storage.getConfig('showLoadTimer')) return;

            const timer = Utils.createElement('div', {
                id: 'blp-load-timer'
            });
            document.body.appendChild(timer);

            window.addEventListener('load', () => this.showTime());
        },

        showTime() {
            setTimeout(() => {
                const timer = Utils.$('#blp-load-timer');
                if (!timer) return;

                const navTiming = performance.getEntriesByType?.('navigation')?.[0];
                if (!navTiming) return;

                const duration = navTiming.duration;
                const text = duration >= 1000
                    ? `${(duration / 1000).toFixed(2)}s`
                    : `${duration.toFixed(0)}ms`;

                timer.innerHTML = `⏱️ ${text}`;
                timer.classList.add('visible');

                setTimeout(() => {
                    timer.classList.remove('visible');
                }, 4000);
            }, 100);
        }
    };

    // ================= MODUŁ: XLSX VIEWER =================
    const XlsxViewer = {
        init() {
            this.addViewButtons();

            // MutationObserver z debounce
            const table = Utils.$(CONFIG.selectors.indexTable);
            if (table) {
                const debouncedAdd = Utils.debounce(() => this.addViewButtons(), 300);
                const observer = new MutationObserver(debouncedAdd);
                observer.observe(table, { childList: true, subtree: true });

                // Cleanup przy opuszczeniu strony
                window.addEventListener('beforeunload', () => observer.disconnect());
            }
        },

        addViewButtons() {
            const table = Utils.$(CONFIG.selectors.indexTable);
            if (!table) return;

            // Szukamy wszystkich linków do pobrania XLS
            Utils.$$('a.contentAttach[href*="/admin/courier/invoices/downloadXls/"]', table).forEach(link => {
                // Sprawdź czy już dodano przycisk
                if (link.nextElementSibling && link.nextElementSibling.classList.contains('blp-xlsx-view-btn')) return;
                
                const row = link.closest('tr');
                if (!row) return;

                const viewBtn = Utils.createElement('a', {
                    href: '#',
                    className: 'blp-xlsx-view-btn',
                    title: 'Wyświetl zestawienie w przeglądarce',
                    innerHTML: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#198754" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                        <circle cx="12" cy="12" r="3"></circle>
                    </svg>`,
                    style: { 
                        display: 'inline-block',
                        marginLeft: '5px',
                        cursor: 'pointer',
                        verticalAlign: 'middle',
                        opacity: '0.8',
                        transition: 'opacity 0.2s, transform 0.2s'
                    },
                    onMouseenter: function() { 
                        this.style.opacity = '1'; 
                        this.style.transform = 'scale(1.15)'; 
                    },
                    onMouseleave: function() { 
                        this.style.opacity = '0.8'; 
                        this.style.transform = 'scale(1)'; 
                    },
                    onClick: (e) => {
                        e.preventDefault();
                        this.loadAndDisplay(link.href, row);
                    }
                });

                // Wstaw przycisk zaraz za linkiem do XLS
                link.insertAdjacentElement('afterend', viewBtn);
            });
        },

        async loadAndDisplay(url, row) {
            const invoiceNumber = row.cells[1]?.textContent.trim() || 'brak numeru';
            const userIdInput = Utils.$('#InvoiceUserId');
            const userId = userIdInput?.value || 'nie znaleziono';

            try {
                UI.showToast('Pobieranie pliku XLSX...', 'info', 2000);

                const response = await Http.gmFetch(url, { responseType: 'arraybuffer' });
                const arr = new Uint8Array(response.response);

                // Walidacja nagłówka ZIP/XLSX
                if (!(arr[0] === 0x50 && arr[1] === 0x4B)) {
                    throw new Error('Plik nie jest prawidłowym plikiem XLSX');
                }

                const workbook = XLSX.read(response.response, { type: 'array' });
                const allRows = XLSX.utils.sheet_to_json(
                    workbook.Sheets[workbook.SheetNames[0]],
                    { header: 1, defval: '' }
                );

                // Znajdź wiersz nagłówkowy
                let headerRowIdx = allRows.findIndex(row =>
                    Array.isArray(row) &&
                    row.some(cell =>
                        typeof cell === 'string' &&
                        (Utils.normalizeHeader(cell) === 'id przesylki' ||
                         (Utils.normalizeHeader(cell).includes('id') &&
                          Utils.normalizeHeader(cell).includes('przesylki')))
                    )
                );

                if (headerRowIdx === -1) headerRowIdx = 0;

                const jsonData = XLSX.utils.sheet_to_json(
                    workbook.Sheets[workbook.SheetNames[0]],
                    { header: 1, defval: '', range: headerRowIdx }
                );

                const htmlContent = this.generateHtml(jsonData, invoiceNumber, userId);
                const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
                window.open(URL.createObjectURL(blob), '_blank');

            } catch (error) {
                console.error('BLPaczka XLSX Error:', error);
                UI.showToast(`Błąd: ${error.message}`, 'error');
            }
        },

        generateHtml(data, invoiceNumber, userId) {
            const filteredData = data.filter(row => row && row.length > 0);

            if (filteredData.length === 0) {
                return this.getHtmlTemplate(invoiceNumber, userId, '<p>Nie znaleziono danych w pliku.</p>');
            }

            const headers = filteredData[0];
            const idColumnIndex = headers.findIndex(h => Utils.normalizeHeader(h) === 'id przesylki');
            const nrListuIndex = headers.findIndex(h => Utils.normalizeHeader(h) === 'nr listu');

            let tableHtml = '<table><thead><tr>';
            headers.forEach(h => {
                tableHtml += `<th>${Utils.escapeHtml(String(h))}</th>`;
            });
            tableHtml += '</tr></thead><tbody>';

            for (let i = 1; i < filteredData.length; i++) {
                const rowData = filteredData[i];
                const przesylkaId = idColumnIndex !== -1 ? rowData[idColumnIndex] : null;
                const linkUrl = przesylkaId
                    ? `https://api.blpaczka.com/admin/courier/orders/view/${przesylkaId}`
                    : null;

                tableHtml += '<tr>';
                rowData.forEach((cell, idx) => {
                    const cellValue = cell !== null ? Utils.escapeHtml(String(cell)) : '';
                    if ((idx === idColumnIndex || idx === nrListuIndex) && linkUrl && cell) {
                        tableHtml += `<td><a href="${linkUrl}" target="_blank" class="id-link">${cellValue}</a></td>`;
                    } else {
                        tableHtml += `<td>${cellValue}</td>`;
                    }
                });
                tableHtml += '</tr>';
            }

            tableHtml += '</tbody></table>';
            return this.getHtmlTemplate(invoiceNumber, userId, tableHtml);
        },

        getHtmlTemplate(invoiceNumber, userId, content) {
            return `<!DOCTYPE html>
<html lang="pl">
<head>
    <meta charset="utf-8">
    <title>Zestawienie: ${Utils.escapeHtml(invoiceNumber)}</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0; padding: 20px;
            background: #f5f7fa; color: #333;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #fff; padding: 25px; border-radius: 12px;
            margin-bottom: 25px; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
        }
        .header h1 { margin: 0 0 10px 0; font-size: 24px; }
        .header h2 { margin: 0; font-size: 16px; opacity: 0.9; font-weight: normal; }
        table {
            width: 100%; border-collapse: collapse;
            background: #fff; border-radius: 8px;
            overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        th, td {
            padding: 12px 15px; text-align: left;
            border-bottom: 1px solid #eee;
        }
        th {
            background: #f8f9fa; font-weight: 600;
            color: #555; font-size: 13px;
            text-transform: uppercase; letter-spacing: 0.5px;
        }
        tr:hover { background: #f8f9fa; }
        tr:last-child td { border-bottom: none; }
        .id-link {
            color: #667eea; text-decoration: none;
            font-weight: 600;
        }
        .id-link:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="header">
        <h1>📋 Zestawienie dopłat: ${Utils.escapeHtml(invoiceNumber)}</h1>
        <h2>Użytkownik ID: ${Utils.escapeHtml(userId)}</h2>
    </div>
    ${content}
</body>
</html>`;
        }
    };

    // ================= MODUŁ: NARZĘDZIA KOPIOWANIA I API =================
    const CopyAndApiTools = {
        init() {
            this.addClientButtons();
            this.addWaybillCopyButton();
            this.createFloatingButton();
        },

        getUserInfo() {
            const row = Utils.$$('tr').find(tr => tr.textContent.includes('Nadana przez użytkownika'));
            if (!row) return null;

            const td = row.querySelectorAll('td')[1];
            if (!td) return null;

            const userIdLink = td.querySelector('a.contentEdit');
            if (!userIdLink) return null;

            const userId = userIdLink.textContent.trim();

            // Pobierz tekst po linku
            let text = '';
            let node = userIdLink.nextSibling;
            while (node) {
                if (node.nodeType === Node.TEXT_NODE) {
                    text += node.textContent;
                }
                node = node.nextSibling;
            }
            text = text.trim();

            // Parse: "Nazwa - email@example.com"
            const match = text.match(/^(.+?)\s*-\s*([^\s]+@[^\s]+)$/);
            let userName = '', userEmail = '';

            if (match) {
                userName = match[1].trim();
                userEmail = match[2].trim();
            } else {
                const parts = text.split('-').map(x => x.trim());
                userName = parts[0] || '';
                userEmail = parts[1] || '';
            }

            return { userId, userName, userEmail, cell: td, linkHref: userIdLink.href };
        },

        getSenderData() {
            const h2 = Utils.$$('h2').find(h => h.textContent.trim().toLowerCase() === 'dane nadawcy');
            if (!h2) return {};

            let table = h2.nextElementSibling;
            while (table && table.tagName !== 'TABLE') {
                table = table.nextElementSibling;
            }
            if (!table) return {};

            const sender = {};
            Utils.$$('tr', table).forEach(tr => {
                const tds = tr.querySelectorAll('td');
                if (tds.length < 2) return;

                const label = tds[0].textContent.trim().toLowerCase();
                const value = tds[1].textContent.trim();

                switch (label) {
                    case 'imię i nazwisko': sender.name = value; break;
                    case 'firma': sender.company = value; break;
                    case 'e-mail': sender.email = value; break;
                    case 'telefon': sender.phone = value; break;
                    case 'adres':
                        const miasto = value.match(/Miasto.*?:\s*([^\n<]+)/i);
                        const kod = value.match(/Kod Pocztowy.*?:\s*([^\n<]+)/i);
                        const ulica = value.match(/Ulica.*?:\s*([^\n<]+)/i);
                        sender.city = miasto ? miasto[1].trim() : '';
                        sender.postal = kod ? kod[1].trim() : '';
                        sender.street = ulica ? ulica[1].replace(/\s+/g, ' ').trim() : '';
                        break;
                }
            });

            return sender;
        },

        addClientButtons() {
            const userInfo = this.getUserInfo();
            if (!userInfo || !userInfo.cell) return;

            const cell = userInfo.cell;

            // Usuń istniejące przyciski
            Utils.$$('.blp-client-btn, #blp-panel-btn', cell).forEach(el => el.remove());

            // Przycisk "Kopiuj dane klienta"
            const copyBtn = UI.createButton('📋 Kopiuj dane klienta', {
                variant: 'primary',
                onClick: async (e) => {
                    e.preventDefault();
                    await this.copyClientData(copyBtn, userInfo);
                }
            });
            copyBtn.classList.add('blp-client-btn');
            copyBtn.style.marginTop = '10px';

            // Przycisk "Przejdź do panelu"
            const userIdClean = userInfo.userId.replace('#', '').trim();
            const panelBtn = Utils.createElement('a', {
                id: 'blp-panel-btn',
                href: `/admin/klienci/user_id:${userIdClean}`,
                target: '_blank',
                className: 'blp-btn blp-btn-info',
                textContent: '👤 Panel klienta',
                style: { marginLeft: '10px', marginTop: '10px' }
            });

            cell.appendChild(document.createElement('br'));
            cell.appendChild(copyBtn);
            cell.appendChild(panelBtn);
        },

        async copyClientData(btn, userInfo) {
            const originalText = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '⏳ Pobieram...';

            try {
                const response = await Http.gmFetch(userInfo.linkHref);
                const parser = new DOMParser();
                const doc = parser.parseFromString(response.responseText, 'text/html');

                const nip = doc.getElementById('BrokerVatNip')?.value.trim() || '';
                const company = doc.getElementById('BrokerVatCompany')?.value.trim() || '';
                const fullname = doc.getElementById('BrokerVatName')?.value.trim() || '';
                const sender = this.getSenderData();

                const lines = [
                    `${userInfo.userId} ${userInfo.userName} - ${userInfo.userEmail}`.trim(),
                    nip,
                    `${company} ${fullname}`.trim(),
                    sender.street || '',
                    `${sender.postal || ''} ${sender.city || ''}`.trim(),
                    sender.email || '',
                    `${sender.phone || ''} ${sender.name || ''}`.trim()
                ].filter(line => line);

                GM_setClipboard(lines.join('\n'));

                btn.innerHTML = '✅ Skopiowano!';
                UI.showToast('Dane klienta skopiowane do schowka', 'success');

            } catch (error) {
                console.error('BLPaczka copy error:', error);
                btn.innerHTML = '❌ Błąd';
                UI.showToast(`Błąd: ${error.message}`, 'error');
            }

            setTimeout(() => {
                btn.innerHTML = originalText;
                btn.disabled = false;
            }, 2000);
        },

        addWaybillCopyButton() {
            const labelCell = Utils.$$('td').find(td => td.textContent.trim() === 'List przewozowy');
            if (!labelCell) return;

            const dataCell = labelCell.nextElementSibling;
            if (!dataCell) return;

            const strong = dataCell.querySelector('strong');
            if (!strong || dataCell.querySelector('.blp-waybill-copy')) return;

            const copyBtn = UI.createButton('📋', {
                variant: 'secondary',
                size: 'small',
                onClick: (e) => {
                    e.preventDefault();
                    const waybill = strong.textContent.trim();
                    GM_setClipboard(waybill);
                    UI.showToast(`Skopiowano: ${waybill}`, 'success');
                }
            });
            copyBtn.classList.add('blp-waybill-copy');
            copyBtn.title = 'Kopiuj numer listu';
            copyBtn.style.marginLeft = '10px';

            strong.parentNode.insertBefore(copyBtn, strong.nextSibling);
        },

        createFloatingButton() {
            if (Utils.$('.blp-floating-btn')) return;

            const btn = Utils.createElement('button', {
                className: 'blp-floating-btn',
                innerHTML: '🛠️',
                title: 'Analizuj dane API (JSON/XML)',
                onClick: () => this.showFileChooser()
            });

            document.body.appendChild(btn);
        },

        showFileChooser() {
            const apiContainer = Utils.$(CONFIG.selectors.apiHistory);
            if (!apiContainer) {
                UI.showModal('<p>Nie znaleziono kontenera "Historia API".</p>', { title: '❌ Błąd' });
                return;
            }

            const links = Utils.$$('a', apiContainer).filter(link => {
                const text = (link.textContent || '').toLowerCase();
                return (text.includes('.json') || text.includes('.xml')) &&
                       (text.includes('request') || text.includes('response'));
            });

            if (links.length === 0) {
                UI.showModal('<p>Nie znaleziono plików request ani response.</p>', { title: '❌ Błąd' });
                return;
            }

            const content = Utils.createElement('div', {
                style: { display: 'grid', gap: '10px' }
            });

            links.forEach(link => {
                const btn = UI.createButton(`📄 ${link.textContent.trim()}`, {
                    variant: 'secondary',
                    onClick: () => this.fetchAndDisplayFile(link)
                });
                btn.style.justifyContent = 'flex-start';
                btn.style.width = '100%';
                content.appendChild(btn);
            });

            UI.showModal(content, { title: '📁 Wybierz plik do wyświetlenia' });
        },

        async fetchAndDisplayFile(linkElement) {
            const fileName = linkElement.textContent.trim();
            const isXml = fileName.toLowerCase().includes('.xml');

            UI.showModal('<p>⏳ Pobieranie danych...</p>', { title: `📄 ${fileName}` });

            try {
                const response = await Http.fetch(linkElement.href);
                let content, formattedContent;

                if (isXml) {
                    content = await response.text();
                    formattedContent = Utils.formatXml(content);
                } else {
                    const json = await response.json();
                    formattedContent = JSON.stringify(json, null, 2);

                    // Dodatkowe info z JSON
                    if (typeof json.labelless !== 'undefined') {
                        formattedContent = `// Przesyłka bez etykiety: ${json.labelless ? 'Tak' : 'Nie'}\n\n${formattedContent}`;
                    }
                }

                const pre = Utils.createElement('pre', {
                    className: 'blp-modal-pre',
                    textContent: formattedContent
                });

                UI.showModal(pre, {
                    title: `📄 ${fileName}`,
                    showBack: true,
                    onBack: () => this.showFileChooser()
                });

            } catch (error) {
                console.error('BLPaczka API error:', error);
                UI.showModal(`<p>❌ Błąd: ${error.message}</p>`, {
                    title: '❌ Błąd',
                    showBack: true,
                    onBack: () => this.showFileChooser()
                });
            }
        }
    };

    // ================= MODUŁ: LISTA ZLECEŃ =================
    const OrderListTools = {
        init() {
            this.clearDateIfNeeded();
            this.createControls();
        },

        clearDateIfNeeded() {
            if (Storage.getConfig('clearDateFrom')) {
                const dateInput = Utils.$('#DateFrom');
                if (dateInput) dateInput.value = '';
            }
        },

        createControls() {
            const anchor = Utils.$(CONFIG.selectors.navTitle);
            if (!anchor || Utils.$('#blp-list-controls')) return;

            const controls = Utils.createElement('div', { id: 'blp-list-controls' });

            // Prawa grupa - przyciski
            const rightGroup = Utils.createElement('div', { className: 'blp-controls-group' });

            const buttons = [
                { text: '📥 Wczytaj wszystko', variant: 'primary', id: 'blp-load-all', action: () => this.loadAllPages() },
                { text: '📋 Wszystkie', variant: 'info', filter: 'all' },
                { text: '💰 Z pobraniem', variant: 'success', filter: 'cod' },
                { text: '🚚 Niedostarczone', variant: 'warning', filter: 'undelivered' },
                { text: '❌ Anulowane', variant: 'secondary', filter: 'canceled' }
            ];

            buttons.forEach(btnInfo => {
                const btn = UI.createButton(btnInfo.text, {
                    variant: btnInfo.variant,
                    onClick: btnInfo.filter ? () => this.applyFilter(btnInfo.filter) : btnInfo.action
                });
                if (btnInfo.id) btn.id = btnInfo.id;
                rightGroup.appendChild(btn);
            });

            // Licznik
            const counter = Utils.createElement('span', { id: 'blp-visible-count' });
            rightGroup.appendChild(counter);

            controls.appendChild(rightGroup);
            anchor.insertAdjacentElement('afterend', controls);

            this.updateVisibleCount();
        },

        async loadAllPages() {
            const btn = Utils.$('#blp-load-all');
            if (!btn || btn.disabled) return;

            btn.disabled = true;
            const originalText = btn.innerHTML;

            try {
                const mainTable = Utils.$(CONFIG.selectors.mainTable);
                if (!mainTable) throw new Error('Nie znaleziono tabeli');

                const recordsStrong = Utils.$(CONFIG.selectors.recordsCount);
                const totalRecords = recordsStrong ? parseInt(recordsStrong.textContent, 10) : 0;
                const itemsPerPage = Storage.getConfig('itemsPerPage');
                const totalPages = Math.ceil(totalRecords / itemsPerPage);

                if (totalPages > 50) {
                    if (!confirm(`Czy na pewno wczytać ${totalPages} stron? To może chwilę potrwać.`)) {
                        btn.disabled = false;
                        btn.innerHTML = originalText;
                        return;
                    }
                }

                const baseUrl = window.location.href.replace(/\/page:\d+/, '').replace(/\/$/, '');
                const delay = Storage.getConfig('fetchDelayMs');

                for (let i = 2; i <= totalPages; i++) {
                    btn.innerHTML = `⏳ Strona ${i}/${totalPages}...`;

                    try {
                        const response = await Http.fetch(`${baseUrl}/page:${i}`);
                        const html = await response.text();
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(html, 'text/html');

                        // Fallback dla :has()
                        const rows = Utils.$$('#site_index_table table tr', doc);
                        const dataRows = Utils.filterRowsWithTd(rows);

                        dataRows.forEach(row => {
                            mainTable.appendChild(row.cloneNode(true));
                        });

                        await Utils.sleep(delay);

                    } catch (pageError) {
                        console.warn(`BLPaczka: Błąd strony ${i}:`, pageError);
                    }
                }

                // Usuń paginację
                Utils.$(CONFIG.selectors.paginatorBox)?.remove();

                btn.innerHTML = '✅ Gotowe!';
                btn.style.backgroundColor = '#28a745';
                this.updateVisibleCount();

                UI.showToast(`Wczytano ${totalPages} stron`, 'success');

            } catch (error) {
                console.error('BLPaczka loadAll error:', error);
                btn.innerHTML = '❌ Błąd';
                UI.showToast(`Błąd: ${error.message}`, 'error');
            }

            setTimeout(() => {
                btn.innerHTML = originalText;
                btn.disabled = false;
                btn.style.backgroundColor = '';
            }, 3000);
        },

        applyFilter(filterType) {
            const table = Utils.$(CONFIG.selectors.mainTable);
            if (!table) return;

            const rows = Utils.filterRowsWithTd(Utils.$$('tr', table));
            let visibleCount = 0;

            rows.forEach(row => {
                const text = row.textContent || '';
                const isCanceled = row.classList.contains('order-canceled');
                const isDelivered = text.includes('Doręczono:');
                const isApiError = row.querySelector('div.api-error') !== null;
                const hasCod = text.includes('Pobranie:');

                let show = false;

                switch (filterType) {
                    case 'all':
                        show = true;
                        break;
                    case 'canceled':
                        show = isCanceled;
                        break;
                    case 'undelivered':
                        show = !isCanceled && !isDelivered && !isApiError;
                        break;
                    case 'cod':
                        show = hasCod;
                        break;
                }

                row.style.display = show ? '' : 'none';
                if (show) visibleCount++;
            });

            this.updateVisibleCount(visibleCount);
        },

        updateVisibleCount(count) {
            const counter = Utils.$('#blp-visible-count');
            if (!counter) return;

            if (typeof count === 'undefined') {
                const table = Utils.$(CONFIG.selectors.mainTable);
                if (table) {
                    const rows = Utils.filterRowsWithTd(Utils.$$('tr', table));
                    count = rows.filter(r => r.style.display !== 'none').length;
                } else {
                    count = 0;
                }
            }

            counter.innerHTML = `Wyświetlono: <strong>${count}</strong>`;
        }
    };

    // ================= MODUŁ: IKONY FAKTUR =================
    const ClientListIcons = {
        init() {
            this.addIcons();

            const table = Utils.$(CONFIG.selectors.indexTable);
            if (table) {
                const debouncedAdd = Utils.debounce(() => this.addIcons(), 300);
                const observer = new MutationObserver(debouncedAdd);
                observer.observe(table, { childList: true, subtree: true });
                window.addEventListener('beforeunload', () => observer.disconnect());
            }
        },

        addIcons() {
            const table = Utils.$(CONFIG.selectors.mainTable);
            if (!table) return;

            const rows = Utils.$$('tr', table);
            if (rows.length < 2) return;

            // Znajdź indeksy kolumn
            const headers = rows[0].querySelectorAll('th, td');
            let userIdIdx = -1, actionsIdx = -1;

            headers.forEach((h, i) => {
                const text = h.textContent.toLowerCase();
                if (text.includes('user_id')) userIdIdx = i;
                if (text.includes('akcje')) actionsIdx = i;
            });

            if (userIdIdx === -1 || actionsIdx === -1) return;

            rows.slice(1).forEach(row => {
                const cells = row.cells;
                if (!cells || cells.length <= actionsIdx) return;

                const actionsCell = cells[actionsIdx];
                if (actionsCell.querySelector('.blp-invoice-icon')) return;

                const userId = cells[userIdIdx]?.textContent.trim();
                if (!userId) return;

                const icon = Utils.createElement('a', {
                    href: `/admin/courier/invoices/index/user_id:${userId}`,
                    className: 'blp-invoice-icon',
                    title: 'Faktury klienta',
                    innerHTML: `<svg width="18" height="18" viewBox="0 0 20 20" fill="#ffc107" style="vertical-align:middle">
                        <rect x="3" y="2" width="14" height="16" rx="2" stroke="#b98a00" stroke-width="1"/>
                        <line x1="6" y1="6" x2="14" y2="6" stroke="#b98a00" stroke-width="1"/>
                        <line x1="6" y1="9" x2="14" y2="9" stroke="#b98a00" stroke-width="1"/>
                        <line x1="6" y1="12" x2="10" y2="12" stroke="#b98a00" stroke-width="1"/>
                    </svg>`
                });

                actionsCell.appendChild(icon);
            });
        }
    };

    // ================= MODUŁ: PANEL USTAWIEŃ =================
    const SettingsPanel = {
        show() {
            const content = Utils.createElement('div', { className: 'blp-settings-grid' });

            const settings = [
                { key: 'darkMode', label: '🌙 Tryb ciemny' },
                { key: 'showLoadTimer', label: 'Pokazuj czas ładowania strony' },
                { key: 'clearDateFrom', label: "Czyść datę 'Od' na liście zleceń" },
                { key: 'enableKeyboardShortcuts', label: 'Włącz skróty klawiaturowe' },
                { key: 'autoCollapseSearchPanel', label: 'Automatycznie zwijaj panel wyszukiwania' }
            ];

            settings.forEach(setting => {
                const item = Utils.createElement('div', { className: 'blp-settings-item' });

                const checkbox = Utils.createElement('input', {
                    type: 'checkbox',
                    id: `blp-setting-${setting.key}`
                });
                checkbox.checked = Storage.getConfig(setting.key);
                checkbox.addEventListener('change', () => {
                    Storage.setConfig(setting.key, checkbox.checked);
                    // Specjalna obsługa dark mode - natychmiast zastosuj
                    if (setting.key === 'darkMode') {
                        DarkMode.toggle(checkbox.checked);
                    }
                });

                const label = Utils.createElement('label', {
                    htmlFor: `blp-setting-${setting.key}`,
                    textContent: setting.label
                });

                item.appendChild(checkbox);
                item.appendChild(label);
                content.appendChild(item);
            });

            // Info o wersji
            const versionInfo = Utils.createElement('div', {
                style: {
                    gridColumn: '1 / -1',
                    marginTop: '20px',
                    paddingTop: '15px',
                    borderTop: '1px solid #eee',
                    fontSize: '12px',
                    color: '#888',
                    textAlign: 'center'
                },
                innerHTML: `BLPaczka All-In-One v${CONFIG.version}<br>
                           <strong>Skróty:</strong> Ctrl+Shift+F (przesyłka) | Ctrl+Shift+K (klient)`
            });
            content.appendChild(versionInfo);

            UI.showModal(content, { title: '⚙️ Ustawienia BLPaczka', width: '500px' });
        }
    };

    // ================= MODUŁ: DARK MODE =================
    const DarkMode = {
        init() {
            // Zastosuj zapisany stan
            const isDark = Storage.getConfig('darkMode');
            if (isDark) {
                this.toggle(true);
            }

            // Dodaj przycisk toggle
            this.addToggleButton();
        },

        toggle(enable) {
            if (enable) {
                document.documentElement.classList.add('blp-dark-mode');
                document.body.classList.add('blp-dark-mode');
            } else {
                document.documentElement.classList.remove('blp-dark-mode');
                document.body.classList.remove('blp-dark-mode');
            }
            this.updateToggleButton(enable);
        },

        addToggleButton() {
            if (Utils.$('#blp-dark-mode-toggle')) return;

            const isDark = Storage.getConfig('darkMode');
            const btn = Utils.createElement('button', {
                id: 'blp-dark-mode-toggle',
                title: 'Przełącz tryb ciemny',
                innerHTML: isDark ? '☀️' : '🌙',
                onClick: () => {
                    const newState = !document.body.classList.contains('blp-dark-mode');
                    Storage.setConfig('darkMode', newState);
                    this.toggle(newState);
                }
            });

            document.body.appendChild(btn);
        },

        updateToggleButton(isDark) {
            const btn = Utils.$('#blp-dark-mode-toggle');
            if (btn) {
                btn.innerHTML = isDark ? '☀️' : '🌙';
            }
        }
    };

    // ================= MODUŁ: OCHRONA PRZED BLOKADĄ =================
    const BlockProtection = {
        // Lista niebezpiecznych ścieżek które obciążają bazę danych
        dangerousPaths: [
            '/admin/courier/stats',       // Statystyki
            '/admin/courier/cart_orders', // Zamówienia
            '/admin/courier/searches'     // Wyszukiwania
        ],

        init() {
            // Nasłuchujemy każdego kliknięcia na stronie (useCapture = true)
            document.addEventListener('click', (e) => this.handleClick(e), true);
        },

        handleClick(e) {
            // Sprawdzamy, czy kliknięto w link (lub element wewnątrz linku)
            const clickedLink = e.target.closest('a');
            if (!clickedLink) return;

            // Pobieramy adres docelowy
            const linkHref = clickedLink.getAttribute('href');
            if (!linkHref) return;

            // Sprawdzamy, czy adres zawiera niebezpieczną ścieżkę
            const isDangerous = this.dangerousPaths.some(path => linkHref.includes(path));
            
            if (isDangerous) {
                const confirmed = confirm(
                    "⚠️ OSTRZEŻENIE ⚠️\n\n" +
                    "Zamierzasz wejść w zakładkę, która generuje duże obciążenie bazy danych.\n\n" +
                    "Ta operacja może zablokować system na kilka minut!\n\n" +
                    "Czy na pewno chcesz kontynuować?"
                );

                if (!confirmed) {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log('🛡️ BLPaczka: Zablokowano wejście w:', linkHref);
                    UI.showToast('Anulowano wejście w obciążającą zakładkę', 'warning');
                }
            }
        }
    };

    // ================= ROUTER - GŁÓWNA LOGIKA =================
    function initRouter() {
        const path = window.location.pathname;
        const host = window.location.hostname;
        const isAdminPanel = host.includes('api.blpaczka.com');

        // Moduły tylko dla panelu admina (api.blpaczka.com)
        if (isAdminPanel) {
            SearchPanel.init();
            DarkMode.init();  // Tryb ciemny
        }
        
        // Pozostałe moduły
        LoadTimer.init();
        BlockProtection.init();  // Ochrona przed blokadą - zawsze aktywna

        // Widok szczegółów zlecenia
        if (path.includes('/admin/courier/orders/view/')) {
            CopyAndApiTools.init();
        }
        // Lista zleceń
        else if (path.includes('/admin/courier/orders') && !path.includes('/view/')) {
            OrderListTools.init();
        }
        // Lista faktur
        else if (path.includes('/admin/courier/invoices')) {
            XlsxViewer.init();
        }
        // Lista klientów
        else if (path.includes('/admin/klienci')) {
            ClientListIcons.init();
        }

        // Dodaj przycisk ustawień do panelu wyszukiwania
        setTimeout(() => {
            const searchPanel = Utils.$('#blp-search-panel');
            if (searchPanel && !Utils.$('#blp-settings-btn', searchPanel)) {
                const header = Utils.$('.blp-search-header', searchPanel);
                if (header) {
                    const settingsBtn = Utils.createElement('span', {
                        id: 'blp-settings-btn',
                        innerHTML: '⚙️',
                        title: 'Ustawienia',
                        style: {
                            cursor: 'pointer',
                            marginRight: '10px',
                            fontSize: '14px',
                            opacity: '0.7',
                            transition: 'opacity 0.2s'
                        },
                        onClick: () => SettingsPanel.show(),
                        onMouseenter: function() { this.style.opacity = '1'; },
                        onMouseleave: function() { this.style.opacity = '0.7'; }
                    });
                    header.insertBefore(settingsBtn, header.lastElementChild);
                }
            }
        }, 500);
    }

    // ================= BOOTSTRAP =================
    function bootstrap() {
        // Wstrzyknij style jak najwcześniej
        if (document.head) {
            injectStyles();
        } else {
            document.addEventListener('DOMContentLoaded', injectStyles);
        }

        // Inicjalizuj router po załadowaniu DOM
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initRouter);
        } else {
            initRouter();
        }

        console.log(`%c🚀 BLPaczka All-In-One v${CONFIG.version} załadowany!`, 'color: #28a745; font-weight: bold; font-size: 14px;');
        console.log('%c   Skróty: Ctrl+Shift+F (przesyłka) | Ctrl+Shift+K (klient)', 'color: #666; font-size: 11px;');
    }

    bootstrap();

})();
