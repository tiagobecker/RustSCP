import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enUS from './locales/en-US.json';
import ptBR from './locales/pt-BR.json';

function readSavedLanguage(): string | null {
  try {
    return localStorage.getItem('rustscp_language');
  } catch {
    return null;
  }
}

const savedLang = readSavedLanguage();
const browserLang = (typeof navigator !== 'undefined' ? navigator.language : 'en-US').toLowerCase();
const defaultLang = savedLang || (browserLang.startsWith('pt') ? 'pt-BR' : 'en-US');

/** Keeps <html lang> in sync so VoiceOver pronunciation and spellcheck follow the UI language. */
function syncDocumentLang(lng: string) {
  if (typeof document !== 'undefined' && lng) document.documentElement.lang = lng;
}

i18n.use(initReactI18next).init({
  resources: {
    'en-US': { translation: enUS },
    'pt-BR': { translation: ptBR },
  },
  lng: defaultLang,
  fallbackLng: 'en-US',
  interpolation: {
    escapeValue: false,
  },
});

syncDocumentLang(defaultLang);

i18n.on('languageChanged', (lng) => {
  syncDocumentLang(lng);
  try {
    localStorage.setItem('rustscp_language', lng);
  } catch {
    // storage unavailable: the choice still applies for this session
  }
});

export default i18n;
