import { useState, useEffect, useCallback, useRef } from 'react';

export interface TimeEstimation {
  progress: number;
  setProgress: (progress: number) => void;
  estimatedTimeRemaining: string | null;
}

function getSecondsFromEstimate(estimate: string | null): number | null {
  if (!estimate) return null;
  
  let seconds = 0;
  
  if (estimate.includes('h')) {
    const hours = parseInt(estimate.split('h')[0], 10);
    seconds += hours * 3600;
    estimate = estimate.split('h')[1];
  }
  
  if (estimate?.includes('m')) {
    const minutes = parseInt(estimate.split('m')[0], 10);
    seconds += minutes * 60;
    estimate = estimate.split('m')[1];
  }
  
  if (estimate?.includes('s')) {
    const secs = parseInt(estimate.split('s')[0], 10);
    seconds += secs;
  }
  
  return seconds;
}

export function useTimeEstimation(): TimeEstimation {
  const [progress, setProgressState] = useState(0);
  const [estimatedTimeRemaining, setEstimatedTimeRemaining] = useState<string | null>(null);
  
  // Store timing data to avoid dependency cycles
  const startTimeRef = useRef<number | null>(null);
  const progressHistoryRef = useRef<Array<{time: number, progress: number, textLength?: number}>>([]);
  const lastProgressUpdateRef = useRef<number>(0);
  const lastEstimateUpdateRef = useRef<number>(0);
  
  const resetState = useCallback(() => {
    startTimeRef.current = null;
    progressHistoryRef.current = [];
    setEstimatedTimeRemaining(null);
    lastEstimateUpdateRef.current = 0;
    lastProgressUpdateRef.current = 0;
  }, []);
  
  const formatTimeRemaining = useCallback((seconds: number): string => {
    if (seconds < 30) {
      return '1m';
    } else if (seconds < 3600) {
      const minutes = Math.round(seconds / 60);
      return `${minutes}m`;
    } else {
      const totalMinutes = Math.round(seconds / 60);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return minutes > 0 
        ? `${hours}h ${minutes}m` 
        : `${hours}h`;
    }
  }, []);

  const calculateMovingAverage = useCallback((data: number[], windowSize: number) => {
    const result = [];
    for (let i = 0; i < data.length; i++) {
      const start = Math.max(0, i - windowSize + 1);
      const window = data.slice(start, i + 1);
      const average = window.reduce((sum, val) => sum + val, 0) / window.length;
      result.push(average);
    }
    return result;
  }, []);

  const calculateTimeRemaining = useCallback((newProgress: number, currentTime: number) => {
    // Initialize start time if this is the first meaningful update
    if (startTimeRef.current === null && newProgress > 0) {
      startTimeRef.current = currentTime;
      progressHistoryRef.current = [{ time: currentTime, progress: newProgress }];
      lastProgressUpdateRef.current = currentTime;
      return;
    }
    
    // Skip if no progress
    if (newProgress <= 0) {
      resetState();
      return;
    }

    // Check if we should update the estimate
    const timeSinceLastUpdate = currentTime - lastProgressUpdateRef.current;
    const shouldSkipUpdate = timeSinceLastUpdate < 3000; // Reduced from 10s to 3s for more responsive updates
    
    const lastDataPoint = progressHistoryRef.current[progressHistoryRef.current.length - 1];
    const timeSinceLastDataPoint = lastDataPoint ? currentTime - lastDataPoint.time : Infinity;
    const progressDifference = lastDataPoint ? newProgress - lastDataPoint.progress : Infinity;
    
    // Store data point if significant time or progress change
    if (timeSinceLastDataPoint > 2000 || Math.abs(progressDifference) > 1) {
      progressHistoryRef.current.push({ time: currentTime, progress: newProgress });
      
      // Keep a sliding window of data points
      const maxDataPoints = 20; // Increased from 5 for smoother averaging
      if (progressHistoryRef.current.length > maxDataPoints) {
        progressHistoryRef.current = [
          progressHistoryRef.current[0], 
          ...progressHistoryRef.current.slice(-maxDataPoints + 1)
        ];
      }
    }
    
    if (shouldSkipUpdate) {
      return;
    }
    
    lastProgressUpdateRef.current = currentTime;
    
    const history = progressHistoryRef.current;
    
    if (history.length < 2) {
      return;
    }
    
    // Calculate progress rates for smoothing
    const rates: number[] = [];
    for (let i = 1; i < history.length; i++) {
      const timeSpan = (history[i].time - history[i-1].time) / 1000; // Convert to seconds
      const progressSpan = history[i].progress - history[i-1].progress;
      if (timeSpan > 0) {
        rates.push(progressSpan / timeSpan);
      }
    }
    
    if (rates.length === 0) return;

    // Apply moving average smoothing to the rates
    const smoothedRates = calculateMovingAverage(rates, Math.min(5, rates.length));
    const currentRate = smoothedRates[smoothedRates.length - 1];
    
    if (currentRate > 0) {
      const remainingProgress = 100 - newProgress;
      const estimatedSeconds = remainingProgress / currentRate;
      
      if (isFinite(estimatedSeconds) && estimatedSeconds > 0) {
        // Apply adaptive dampening based on progress
        const dampingFactor = Math.max(0.2, Math.min(0.8, newProgress / 100));
        const previousEstimate = getSecondsFromEstimate(estimatedTimeRemaining);
        
        const smoothedSeconds = previousEstimate 
          ? (estimatedSeconds * dampingFactor) + (previousEstimate * (1 - dampingFactor))
          : estimatedSeconds;
            
        setEstimatedTimeRemaining(formatTimeRemaining(smoothedSeconds));
        lastEstimateUpdateRef.current = currentTime;
      }
    }
  }, [estimatedTimeRemaining, formatTimeRemaining, resetState, calculateMovingAverage]);
  
  const updateProgress = useCallback((newProgress: number) => {
    const currentTime = Date.now();
    const clampedProgress = Math.max(0, Math.min(100, newProgress));
    
    setProgressState(clampedProgress);
    
    if (clampedProgress === 0) {
      resetState();
    } else if (clampedProgress === 100) {
      setEstimatedTimeRemaining(null);
      lastEstimateUpdateRef.current = currentTime;
      lastProgressUpdateRef.current = currentTime;
    } else {
      calculateTimeRemaining(clampedProgress, currentTime);
    }
  }, [calculateTimeRemaining, resetState]);

  // Reset time estimation when component unmounts
  useEffect(() => {
    return () => {
      resetState();
    };
  }, [resetState]);

  return {
    progress,
    setProgress: updateProgress,
    estimatedTimeRemaining
  };
}