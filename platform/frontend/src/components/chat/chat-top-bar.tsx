"use client";

import {
  Download,
  MoreHorizontal,
  PanelRight,
  Share2,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import { TypingText } from "@/components/ui/typing-text";
import { getConversationDisplayTitle } from "@/lib/chat/chat-utils";
import { cn } from "@/lib/utils";

interface ChatTopBarConversation {
  id: string;
  title: string | null;
  // biome-ignore lint/suspicious/noExplicitAny: UIMessage structure from AI SDK is dynamic
  messages?: any[];
}

interface ChatTopBarProps {
  conversationId: string | undefined;
  conversation: ChatTopBarConversation | null | undefined;
  /** Conversation ids whose title is currently typing-animating in the header. */
  headerAnimatingTitles: Set<string>;
  isRightPanelOpen: boolean;
  onToggleRightPanel: () => void;

  // Actions menu
  canManageShare: boolean;
  isShared: boolean;
  /** True when there is a conversation with at least one message. */
  hasMessages: boolean;
  onShare: () => void;
  onExportMarkdown: () => void;
}

/**
 * Full-width chat top bar: conversation title on the left, a 3-dots actions
 * menu (Share, Download markdown) and the panel open/close toggle anchored on
 * the right. The right-side controls stay in a fixed position whether the side
 * panel is open or closed because this bar spans the whole content area above
 * the panel.
 */
export function ChatTopBar({
  conversationId,
  conversation,
  headerAnimatingTitles,
  isRightPanelOpen,
  onToggleRightPanel,
  canManageShare,
  isShared,
  hasMessages,
  onShare,
  onExportMarkdown,
}: ChatTopBarProps) {
  const hasActions = canManageShare || hasMessages;

  return (
    <header
      className={cn(
        "shrink-0 z-10 bg-background border-b p-2",
        !conversationId && "hidden",
      )}
    >
      <div className="relative flex items-center justify-between gap-2">
        {/* Left - conversation title */}
        {conversationId && conversation && (
          <div className="flex items-center flex-shrink min-w-0">
            {/* Skip TruncatedTooltip while the title animates: its resize
                measurement re-renders on every TypingText tick, which loops
                past React's nested-update cap. */}
            {headerAnimatingTitles.has(conversation.id) ? (
              <h1 className="text-base font-normal text-muted-foreground truncate max-w-[360px] cursor-default">
                <TypingText
                  text={getConversationDisplayTitle(
                    conversation.title,
                    conversation.messages,
                  )}
                  typingSpeed={35}
                  showCursor
                  cursorClassName="bg-muted-foreground"
                />
              </h1>
            ) : (
              <TruncatedTooltip
                content={getConversationDisplayTitle(
                  conversation.title,
                  conversation.messages,
                )}
              >
                <h1 className="text-base font-normal text-muted-foreground truncate max-w-[360px] cursor-default">
                  {getConversationDisplayTitle(
                    conversation.title,
                    conversation.messages,
                  )}
                </h1>
              </TruncatedTooltip>
            )}
          </div>
        )}

        {/* Right - actions menu + panel toggle, anchored to the right edge */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {hasActions && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">More options</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canManageShare && (
                  <DropdownMenuItem onSelect={onShare}>
                    {isShared ? (
                      <>
                        <Users className="h-4 w-4 text-primary" />
                        <span className="text-primary">Shared</span>
                      </>
                    ) : (
                      <>
                        <Share2 className="h-4 w-4" />
                        Share
                      </>
                    )}
                  </DropdownMenuItem>
                )}
                {hasMessages && (
                  <DropdownMenuItem onSelect={onExportMarkdown}>
                    <Download className="h-4 w-4" />
                    Export conversation
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleRightPanel}
                className="h-8 w-8"
                aria-pressed={isRightPanelOpen}
              >
                <PanelRight className="h-4 w-4" />
                <span className="sr-only">Toggle panel</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Toggle panel</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}
