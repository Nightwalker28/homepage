(function () {
  const WIDGET_BASE = "/custom/js";

  window.HomepageCustomWidgets = {
    mount(group, hostClass, extraClass = "", anchorName = "") {
      const existing = group.querySelector(`.${hostClass}`);
      if (existing) return existing;

      const list = group.querySelector("ul.services-list, ul");
      if (!list) return null;

      list.style.removeProperty("display");

      const slots = Array.from(list.children).filter(child => child.tagName === "LI");
      const slot = anchorName
        ? slots.find(child => child.textContent.includes(anchorName))
        : slots.find(child => !child.dataset.customWidgetMounted);
      if (!slot) return null;

      slot.dataset.customWidgetMounted = hostClass;
      slot.classList.add("custom-widget-slot");

      const host = document.createElement("div");
      host.dataset.customWidgetHost = hostClass;
      host.className = [hostClass, extraClass].filter(Boolean).join(" ");
      slot.appendChild(host);
      return host;
    },
  };

  const scripts = [
    "jellyfin.widget.js",
    "jellyfin.slider.widget.js",
    "immich.widget.js",
    "seerr.widget.js",
    "sonarr.widget.js",
    "radarr.widget.js",
    "prowlarr.widget.js",
    "qbit.widget.js",
    "bazarr.widget.js",
    "tdarr.widget.js",
    "calendar.widget.js",
    "adguard.widget.js",
    "speedtest.widget.js",
    "proxmox.widget.js",
  ];

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        resolve();
        return;
      }

      const script = document.createElement("script");
      script.src = src;
      script.defer = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Failed to load ${src}`));

      document.head.appendChild(script);
    });
  }

  async function loadWidgetScripts() {
    for (const file of scripts) {
      await loadScript(`${WIDGET_BASE}/${file}`);
    }
  }

  loadWidgetScripts().catch((error) => {
    console.error("[Homepage custom widget loader]", error);
  });
})();
