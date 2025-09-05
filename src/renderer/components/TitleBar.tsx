import React from 'react';
import {
  DragHandle,
  TitleBar as TitleBarStyled,
  AppIcon,
  AppName,
  AppTagline,
  TitleBarSpacer,
  TitleBarControls,
  TitleBarActions,
  TitleBarAction,
  WindowControls,
  WindowCtrlBtn,
} from '../styles/components';

interface TitleBarProps {
  appIconSrc: string;
  onAboutOpen: () => void;
  onSettingsOpen: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
}

export function TitleBarComponent({
  appIconSrc,
  onAboutOpen,
  onSettingsOpen,
  onMinimize,
  onMaximize,
  onClose,
}: TitleBarProps) {
  return (
    <>
      <DragHandle />
      <TitleBarStyled>
        <AppIcon src={appIconSrc} alt="" draggable={false} />
        <AppName>Meta Mover</AppName>
        <AppTagline>Media File Organizer</AppTagline>
        <TitleBarSpacer />
        <TitleBarControls>
          <TitleBarActions>
            <TitleBarAction $isAbout title="About" onClick={onAboutOpen}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </TitleBarAction>
            <TitleBarAction title="Settings" onClick={onSettingsOpen}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </TitleBarAction>
          </TitleBarActions>
          <WindowControls>
            <WindowCtrlBtn title="Minimize" onClick={onMinimize}>
              &#x2500;
            </WindowCtrlBtn>
            <WindowCtrlBtn title="Maximize" onClick={onMaximize}>
              &#x25A1;
            </WindowCtrlBtn>
            <WindowCtrlBtn $isClose title="Close" onClick={onClose}>
              &#x2715;
            </WindowCtrlBtn>
          </WindowControls>
        </TitleBarControls>
      </TitleBarStyled>
    </>
  );
}
