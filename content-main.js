const nativeFetch = window.fetch;

window.fetch = async function(...args) {
  const url = args[0];

  if (typeof url === 'string' && url.includes('/x/web-interface/wbi/index/top/feed/rcmd')) {
    const currentMode = document.documentElement.getAttribute('data-tabula-mode') || 'pure';
    
    if (currentMode === 'pure' || currentMode === 'origin') {
      return nativeFetch(...args);
    }

    await prepareNetworkState();
    return nativeFetch(...args);
  }

  return nativeFetch(...args);
};

function prepareNetworkState() {
  return new Promise((resolve) => {
    const eventId = Math.random().toString(36).substring(2);
    const fallbackTimer = window.setTimeout(() => {
      window.removeEventListener('tabula_network_ready', onNetworkReady);
      resolve();
    }, 1200);

    function onNetworkReady(e) {
      const detail = e.detail;
      const readyEventId = typeof detail === 'string' ? detail : detail && detail.eventId;

      if (readyEventId === eventId) {
        window.clearTimeout(fallbackTimer);
        window.removeEventListener('tabula_network_ready', onNetworkReady);
        resolve(); 
      }
    }

    window.addEventListener('tabula_network_ready', onNetworkReady);
    window.dispatchEvent(new CustomEvent('tabula_request_triggered', { detail: eventId }));
  });
}
