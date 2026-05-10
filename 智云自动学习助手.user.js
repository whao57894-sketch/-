// ==UserScript==
// @name         智云人才培养平台 - 自动学习助手
// @namespace    https://scriptcat.org
// @version      1.1.0
// @description  自动连播、静音播放、文档直达底部、可调倍速
// @author       ScriptCat
// @match        http://220.178.164.28:28080/course/student/study/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    var CONFIG = {
        endDelay: 2000,          // 视频/文档结束后等待跳转(ms)
        playerCheckMs: 500,      // 播放器检测间隔(ms)
        playerTimeout: 30000,    // 播放器等待超时(ms)
        playbackRate: Number(localStorage.getItem('zy-helper-rate')) || 2,
        enabled: localStorage.getItem('zy-helper-enabled') !== '0',
    };

    var docTimer = null;
    var dialogObserver = null;
    var processing = false;
    var rateTimer = null;

    function log() {
        var args = ['[智云助手]'];
        for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
        console.log.apply(console, args);
    }

    // ====================== 工具函数 ======================

    function $(sel, parent) {
        return (parent || document).querySelector(sel);
    }

    function $$(sel, parent) {
        return (parent || document).querySelectorAll(sel);
    }

    function clampRate(value) {
        var rate = Number(value);
        if (!isFinite(rate)) rate = 2;
        return Math.min(16, Math.max(0.25, rate));
    }

    function taskItems() {
        return $$('ul.res-container.scrollbar.study-menus li.list-item.card-active, .content-left .list-item.card-active, li.list-item.card-active');
    }

    function taskScroller() {
        return $('ul.res-container.scrollbar.study-menus') || $('.content-left') || $('.res-container.scrollbar');
    }

    function normalizeTaskText(item) {
        return (item && item.textContent ? item.textContent : '').replace(/\s+/g, '');
    }

    function isSkippedTask(item) {
        var text = normalizeTaskText(item);
        return text.indexOf('课堂案例源码') !== -1 ||
            text.indexOf('课堂案例代码') !== -1 ||
            (text.indexOf('课堂案例') !== -1 && (text.indexOf('源码') !== -1 || text.indexOf('代码') !== -1));
    }

    function activeTaskItem() {
        var items = taskItems();
        for (var i = 0; i < items.length; i++) {
            if (items[i].classList.contains('active')) return items[i];
        }
        return null;
    }

    function setTaskVisible(item) {
        var scroller = taskScroller();
        if (scroller) {
            var itemRect = item.getBoundingClientRect();
            var scrollerRect = scroller.getBoundingClientRect();
            scroller.scrollTop += itemRect.top - scrollerRect.top - scroller.clientHeight / 2 + itemRect.height / 2;
        }
        item.scrollIntoView({ block: 'center', behavior: 'auto' });
    }

    function safeClickElement(el) {
        if (!el) return false;
        setTaskVisible(el);
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
    }

    function setPlaybackRate(rate) {
        CONFIG.playbackRate = clampRate(rate);
        localStorage.setItem('zy-helper-rate', String(CONFIG.playbackRate));
        applyPlaybackRate();
        updateConsole();
    }

    function applyPlaybackRate() {
        var rate = clampRate(CONFIG.playbackRate);
        try {
            if (window.videojs) {
                var player = window.videojs('vid');
                if (player && player.playbackRate) player.playbackRate(rate);
            }
        } catch (e) { }
        var videos = $$('video');
        for (var i = 0; i < videos.length; i++) {
            videos[i].playbackRate = rate;
            videos[i].muted = true;
        }
    }

    function setupConsole() {
        if ($('#zy-helper-panel')) return;

        var style = document.createElement('style');
        style.textContent =
            '#zy-helper-panel{position:fixed;right:18px;bottom:18px;z-index:999999;background:#1f2937;color:#fff;border:1px solid rgba(255,255,255,.16);box-shadow:0 8px 24px rgba(0,0,0,.22);border-radius:8px;padding:10px 12px;font:13px/1.4 Arial,"Microsoft YaHei",sans-serif;min-width:180px}' +
            '#zy-helper-panel .zy-title{cursor:move;user-select:none}' +
            '#zy-helper-panel .zy-row{display:flex;align-items:center;gap:8px;margin-top:8px}' +
            '#zy-helper-panel .zy-row:first-child{margin-top:0}' +
            '#zy-helper-panel input{width:64px;height:26px;border:1px solid #64748b;border-radius:4px;background:#0f172a;color:#fff;padding:0 6px}' +
            '#zy-helper-panel button{height:28px;border:0;border-radius:4px;background:#2563eb;color:#fff;padding:0 9px;cursor:pointer}' +
            '#zy-helper-panel button.secondary{background:#475569}' +
            '#zy-helper-panel .zy-status{color:#cbd5e1;font-size:12px}';
        document.head.appendChild(style);

        var panel = document.createElement('div');
        panel.id = 'zy-helper-panel';
        panel.innerHTML =
            '<div class="zy-row zy-title"><strong>智云助手</strong><span class="zy-status" id="zy-helper-status"></span></div>' +
            '<div class="zy-row"><label for="zy-helper-rate">倍速</label><input id="zy-helper-rate" type="number" min="0.25" max="16" step="0.25"><button id="zy-helper-apply">应用</button></div>' +
            '<div class="zy-row"><button class="secondary" id="zy-helper-toggle"></button><button class="secondary" id="zy-helper-next">下一项</button></div>';
        document.body.appendChild(panel);
        restorePanelPosition(panel);
        enablePanelDrag(panel);

        $('#zy-helper-rate').addEventListener('change', function () {
            setPlaybackRate(this.value);
        });
        $('#zy-helper-apply').addEventListener('click', function () {
            setPlaybackRate($('#zy-helper-rate').value);
        });
        $('#zy-helper-toggle').addEventListener('click', function () {
            CONFIG.enabled = !CONFIG.enabled;
            localStorage.setItem('zy-helper-enabled', CONFIG.enabled ? '1' : '0');
            if (CONFIG.enabled) handlePage(); else cleanup();
            updateConsole();
        });
        $('#zy-helper-next').addEventListener('click', clickNext);
        updateConsole();
    }

    function restorePanelPosition(panel) {
        try {
            var pos = JSON.parse(localStorage.getItem('zy-helper-panel-pos') || 'null');
            if (!pos) return;
            panel.style.left = Math.max(0, Math.min(window.innerWidth - 80, pos.left)) + 'px';
            panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, pos.top)) + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        } catch (e) { }
    }

    function enablePanelDrag(panel) {
        var handle = $('.zy-title', panel);
        if (!handle) return;
        var dragging = false;
        var offsetX = 0;
        var offsetY = 0;

        handle.addEventListener('mousedown', function (e) {
            dragging = true;
            var rect = panel.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            panel.style.left = rect.left + 'px';
            panel.style.top = rect.top + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            e.preventDefault();
        });

        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            var maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
            var maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
            var left = Math.max(0, Math.min(maxLeft, e.clientX - offsetX));
            var top = Math.max(0, Math.min(maxTop, e.clientY - offsetY));
            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
        });

        document.addEventListener('mouseup', function () {
            if (!dragging) return;
            dragging = false;
            var rect = panel.getBoundingClientRect();
            localStorage.setItem('zy-helper-panel-pos', JSON.stringify({
                left: Math.round(rect.left),
                top: Math.round(rect.top)
            }));
        });
    }

    function updateConsole() {
        var rate = $('#zy-helper-rate');
        var toggle = $('#zy-helper-toggle');
        var status = $('#zy-helper-status');
        if (rate) rate.value = clampRate(CONFIG.playbackRate);
        if (toggle) toggle.textContent = CONFIG.enabled ? '暂停' : '启动';
        if (status) status.textContent = CONFIG.enabled ? '运行中' : '已暂停';
    }

    // ====================== "继续观看"弹窗自动处理 ======================

    function setupDialogObserver() {
        if (dialogObserver) dialogObserver.disconnect();

        dialogObserver = new MutationObserver(function () {
            // 查找"继续观看"按钮
            var dialogs = $$('.el-dialog__wrapper');
            for (var i = 0; i < dialogs.length; i++) {
                var d = dialogs[i];
                if (window.getComputedStyle(d).display === 'none') continue;
                var buttons = $$('.el-button', d);
                for (var j = 0; j < buttons.length; j++) {
                    var btn = buttons[j];
                    var text = btn.textContent.trim();
                    if (text === '继续观看' || text === '立即前往') {
                        log('自动点击弹窗按钮:', text);
                        btn.click();
                        return;
                    }
                }
            }
        });

        dialogObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class']
        });
    }

    // ====================== 导航 ======================

    function clickNext() {
        if (!CONFIG.enabled) return;
        if (processing) return;
        processing = true;

        // 方式1: 视频结束弹窗中的"下一项任务"
        var playEnd = $('.play-end');
        if (playEnd) {
            var display = window.getComputedStyle(playEnd).display;
            if (display !== 'none') {
                var btn = $('.el-button--primary', playEnd);
                if (btn) {
                    log('点击"下一项任务"按钮');
                    btn.click();
                    resetProcessing(3000);
                    return;
                }
            }
        }

        // 方式2: 侧边栏下一个项目。真实滚动容器是 ul.res-container.scrollbar.study-menus，
        // DOM 中包含隐藏任务，直接点击下一项并把侧栏滚动到它的位置。
        var items = taskItems();
        for (var i = 0; i < items.length - 1; i++) {
            if (items[i].classList.contains('active')) {
                var next = null;
                for (var j = i + 1; j < items.length; j++) {
                    if (isSkippedTask(items[j])) {
                        log('跳过课堂案例源码:', normalizeTaskText(items[j]).substring(0, 50));
                        continue;
                    }
                    next = items[j];
                    break;
                }
                if (!next) break;
                log('点击侧边栏:', next.textContent.trim().substring(0, 50));
                safeClickElement(next);
                resetProcessing(3000);
                return;
            }
        }

        log('未找到下一项，可能已到末尾');
        resetProcessing(3000);
    }

    function resetProcessing(delay) {
        setTimeout(function () { processing = false; }, delay || 3000);
    }

    // ====================== 视频页 ======================

    function setupVideo() {
        if (!CONFIG.enabled) return;
        log('视频模式');
        clearInterval(rateTimer);
        rateTimer = setInterval(applyPlaybackRate, 1000);

        var startTime = Date.now();

        function waitPlayer() {
            var player = null;
            try {
                if (window.videojs) {
                    player = window.videojs('vid');
                }
            } catch (e) { }

            if (player && player.tech_ && player.tech_.el_) {
                onPlayerReady(player);
                return;
            }

            if (Date.now() - startTime > CONFIG.playerTimeout) {
                log('等待播放器超时');
                return;
            }

            setTimeout(waitPlayer, CONFIG.playerCheckMs);
        }

        waitPlayer();
    }

    function onPlayerReady(player) {
        // 1. 静音
        player.muted(true);
        try { player.playbackRate(clampRate(CONFIG.playbackRate)); } catch (e) { }
        applyPlaybackRate();
        log('已静音');

        // 2. 自动播放
        var p = player.play();
        if (p && p.catch) {
            p.catch(function (e) { log('自动播放被阻止:', e.message); });
        }

        // 3. 结束时自动下一项
        player.one('ended', function () {
            log('视频播放完毕');
            setTimeout(clickNext, CONFIG.endDelay);
        });
    }

    // ====================== 文档页 ======================

    function setupDocument() {
        if (!CONFIG.enabled) return;
        log('文档模式');

        function startScroll() {
            var imgList = $('.img-list.scrollbar') || $('.content-right.scrollbar');
            if (!imgList) {
                setTimeout(startScroll, 1000);
                return;
            }

            if (imgList.scrollHeight <= imgList.clientHeight && $$('.el-image', imgList).length === 0) {
                setTimeout(startScroll, 1000);
                return;
            }

            var maxScroll = imgList.scrollHeight - imgList.clientHeight;
            if (maxScroll <= 0) {
                // 文档没有溢出，直接跳下一页
                log('文档无需滚动，直接跳转');
                setTimeout(clickNext, CONFIG.endDelay);
                return;
            }

            log('文档直接滚动到底部');
            scrollDocumentBottom(imgList);
            docTimer = setTimeout(function () {
                docTimer = null;
                log('文档滚动完毕');
                clickNext();
            }, CONFIG.endDelay);
        }

        setTimeout(startScroll, 1500);
    }

    function scrollDocumentBottom(container) {
        container.scrollTop = container.scrollHeight;
        container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
        window.scrollTo(0, document.body.scrollHeight);
        var iframe = $('iframe');
        if (iframe) {
            try {
                var doc = iframe.contentDocument || iframe.contentWindow.document;
                doc.documentElement.scrollTop = doc.documentElement.scrollHeight;
                doc.body.scrollTop = doc.body.scrollHeight;
            } catch (e) { }
        }
    }

    // ====================== 清理 ======================

    function cleanup() {
        if (docTimer) {
            clearTimeout(docTimer);
            docTimer = null;
        }
        if (rateTimer) {
            clearInterval(rateTimer);
            rateTimer = null;
        }
    }

    // ====================== 页面路由 ======================

    var lastUrl = location.href;

    function handlePage() {
        cleanup();
        if (!CONFIG.enabled) return;
        var activeItem = activeTaskItem();
        if (isSkippedTask(activeItem)) {
            log('当前为课堂案例源码，直接跳过:', normalizeTaskText(activeItem).substring(0, 50));
            processing = false;
            setTimeout(clickNext, 500);
            return;
        }
        var url = location.href;
        if (url.indexOf('/video') !== -1) {
            setupVideo();
        } else if (url.indexOf('/document') !== -1) {
            setupDocument();
        }
    }

    // SPA URL 变化监听
    var _push = history.pushState;
    history.pushState = function () {
        _push.apply(history, arguments);
        onUrlChange();
    };

    var _replace = history.replaceState;
    history.replaceState = function () {
        _replace.apply(history, arguments);
        onUrlChange();
    };

    window.addEventListener('popstate', onUrlChange);

    function onUrlChange() {
        var url = location.href;
        if (url !== lastUrl) {
            log('URL切换:', url.substring(url.lastIndexOf('/')));
            lastUrl = url;
            setTimeout(handlePage, 800);
        }
    }

    // ====================== 启动 ======================

    function init() {
        log('脚本启动 - 自动学习助手');
        setupConsole();
        setupDialogObserver();
        handlePage();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
