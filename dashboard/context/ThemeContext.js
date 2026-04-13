'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { createClient } from '../lib/supabase';

const ThemeContext = createContext({ theme: 'light', setTheme: () => {} });

export function ThemeProvider({ children, userEmail }) {
  const [theme, setThemeState] = useState('light');
  const supabase = createClient();

  useEffect(() => {
    // Load persisted theme
    const local = localStorage.getItem('gm_theme');
    if (local) {
      setThemeState(local);
      document.documentElement.setAttribute('data-theme', local);
    }
  }, []);

  async function setTheme(newTheme) {
    setThemeState(newTheme);
    localStorage.setItem('gm_theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
    if (userEmail) {
      await supabase.from('user_preferences').upsert(
        { user_email: userEmail, theme: newTheme, updated_at: new Date().toISOString() },
        { onConflict: 'user_email' }
      );
    }
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
