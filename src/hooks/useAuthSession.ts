'use client';

import { useContext } from 'react';
import { AuthSessionContext } from '@/contexts/AuthSessionContext';

export function useAuthSession() {
  const value = useContext(AuthSessionContext);
  if (!value) {
    throw new Error('useAuthSession must be used within an AuthSessionProvider');
  }
  return value;
}
