import { getLanguage } from 'obsidian';
import en from './en';
import zhCN from './zh-cn';
import es from './es';

const localeMap: Record<string, Record<string, string>> = {
	'en': en,
	'zh': zhCN,
	'zh-TW': zhCN, // fallback to simplified chinese for now
	'es': es,
};

export function t(key: keyof typeof en, vars?: Record<string, string>): string {
	const lang = getLanguage() || 'en';
	const dict = localeMap[lang] || localeMap['en'];
	
	let text = (dict && dict[key]) || en[key] || key;
	
	if (vars) {
		for (const [k, v] of Object.entries(vars)) {
			text = text.replace(new RegExp(`{{${k}}}`, 'g'), v);
		}
	}
	
	return text;
}
