/** Use inline Chinese feedback instead of browser-language-dependent validation popups. */
export function validateAuthForm(form: HTMLFormElement): string {
  for (const element of Array.from(form.elements)) {
    if (!(element instanceof HTMLInputElement) || !element.willValidate) continue;
    const label = element.labels?.[0]?.textContent?.trim() || "此项";
    let message = "";
    if (element.validity.valueMissing) message = `请输入${label}`;
    else if (element.minLength >= 0 && element.value.length < element.minLength)
      message = `${label}至少 ${element.minLength} 位`;
    else if (element.maxLength >= 0 && element.value.length > element.maxLength)
      message = `${label}最多 ${element.maxLength} 位`;
    else if (element.validity.patternMismatch)
      message = element.dataset.formatMessage || `请检查${label}的格式`;
    else if (!element.validity.valid) message = `请检查${label}的格式`;
    if (message) {
      element.focus();
      return message;
    }
  }
  return "";
}
