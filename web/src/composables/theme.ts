import { computed, inject, ref, watch, type InjectionKey } from "vue";
type Preference = "system" | "light" | "dark";
const normalize = (value: unknown): Preference =>
  value === "light" || value === "dark" ? value : "system";
export function createTheme() {
  const key = "douyin-onebot-theme";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const systemDark = ref(system.matches),
    preference = ref<Preference>("system");
  try {
    preference.value = normalize(localStorage.getItem(key));
  } catch {}
  const dark = computed(
    () =>
      preference.value === "dark" ||
      (preference.value === "system" && systemDark.value),
  );
  const asset = (name: string) => `/${name}${dark.value ? "-dark" : ""}.svg`;
  const stop = watch(
    dark,
    (value) => {
      document.documentElement.dataset.theme = value ? "dark" : "light";
      document.querySelector<HTMLMetaElement>(
        'meta[name="theme-color"]',
      )!.content = value ? "#121a21" : "#f6f7f9";
      document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href =
        asset("logo");
    },
    { immediate: true },
  );
  function setPreference(value: Preference) {
    preference.value = value;
    try {
      localStorage.setItem(key, value);
    } catch {}
  }
  const changed = () => {
    systemDark.value = system.matches;
  };
  const stored = (event: StorageEvent) => {
    if (event.key === key || event.key === null)
      preference.value = normalize(event.newValue);
  };
  system.addEventListener("change", changed);
  window.addEventListener("storage", stored);
  return {
    preference,
    asset,
    setPreference,
    dispose() {
      stop();
      system.removeEventListener("change", changed);
      window.removeEventListener("storage", stored);
    },
  };
}
export const themeKey: InjectionKey<ReturnType<typeof createTheme>> =
  Symbol("theme");
export function useTheme() {
  return inject(themeKey)!;
}
