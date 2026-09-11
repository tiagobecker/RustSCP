import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enUS from './locales/en-US.json';
import ptBR from './locales/pt-BR.json';

const savedLang = localStorage.getItem('rustscp_language');
const browserLang = navigator.language.toLowerCase();
const defaultLang = savedLang || (browserLang.startsWith('pt') ? 'pt-BR' : 'en-US');

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

i18n.on('languageChanged', (lng) => {
  localStorage.setItem('rustscp_language', lng);
});

export default i18n;
