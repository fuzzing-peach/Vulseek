import Cookies from "js-cookie";
import type { LanguageCode } from "@/lib/languages";

export default function useLocale() {
	const currentLocale = (Cookies.get("VULSEEK_LOCALE") ?? "en") as LanguageCode;

	const setLocale = (locale: LanguageCode) => {
		Cookies.set("VULSEEK_LOCALE", locale, { expires: 365 });
		window.location.reload();
	};

	return {
		locale: currentLocale,
		setLocale,
	};
}
