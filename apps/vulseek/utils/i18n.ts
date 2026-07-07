import type { NextApiRequestCookies } from "next/dist/server/api-utils";

export function getLocale(cookies: NextApiRequestCookies) {
	const locale = cookies.VULSEEK_LOCALE ?? "en";
	return locale;
}

import { serverSideTranslations as originalServerSideTranslations } from "next-i18next/serverSideTranslations";
import { Languages } from "@/lib/languages";

export const serverSideTranslations = (
	locale: string,
	namespaces = ["common"],
) =>
	originalServerSideTranslations(locale, namespaces, {
		fallbackLng: "en",
		keySeparator: false,
		reloadOnPrerender: process.env.NODE_ENV !== "production",
			i18n: {
				defaultLocale: "en",
				locales: Object.values(Languages).map((language) => language.code),
				localeDetection: false,
			},
		});
