/**
 * Unified Navigation Component
 *
 * Regular portal navigation with:
 * - Chat (all users)
 * - DB Connection (admin only)
 * - Settings (admin only)
 * - Admin (admin only)
 */

import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Database,
  MessageSquare,
  Settings,
  LogOut,
  Menu,
  X,
  Shield,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface NavItem {
  path: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  adminOnly?: boolean;
}

const navItems: NavItem[] = [
  {
    path: "/chat",
    label: "Chat",
    description: "Ask questions about your D365 data in natural language",
    icon: <MessageSquare className="h-5 w-5" />,
  },
  {
    path: "/db-connection",
    label: "DB Connection",
    description: "Configure and test database connections",
    icon: <Database className="h-5 w-5" />,
    adminOnly: true,
  },
  {
    path: "/settings",
    label: "Settings",
    description: "Configure database connections and LLM providers",
    icon: <Settings className="h-5 w-5" />,
    adminOnly: true,
  },
  {
    path: "/admin",
    label: "Admin",
    description: "Manage RAG indexing and system configuration",
    icon: <Shield className="h-5 w-5" />,
    adminOnly: true,
  },
];

export function Navigation() {
  const { user, logout } = useAuth();
  const [location] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  if (!user) {
    return null;
  }

  const isAdmin = user.role === "admin";

  const visibleItems = navItems.filter(
    (item) => !item.adminOnly || isAdmin
  );

  const isActive = (path: string) => {
    if (path === "/chat") {
      return location === "/chat" || location.startsWith("/chat/");
    }
    return location === path;
  };

  return (
    <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="container mx-auto px-4 py-3">
        <div className="flex items-center justify-between">
          {/* Logo */}
          <Link href="/chat" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
            <Database className="h-6 w-6 text-blue-600" />
            <span className="text-xl font-semibold hidden sm:inline">
              D365 F&O Data Agent
            </span>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-2 flex-1 justify-center">
            {visibleItems.map((item) => (
              <Tooltip key={item.path}>
                <TooltipTrigger asChild>
                  <Link href={item.path}>
                    <Button
                      variant={isActive(item.path) ? "default" : "ghost"}
                      size="sm"
                      className={cn(
                        "gap-1.5 text-xs",
                        isActive(item.path) && "bg-blue-600 hover:bg-blue-700"
                      )}
                    >
                      <span className="h-4 w-4">{item.icon}</span>
                      <span className="hidden xl:inline">{item.label}</span>
                    </Button>
                  </Link>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">{item.label}</p>
                  <p className="text-xs text-muted-foreground max-w-xs">
                    {item.description}
                  </p>
                </TooltipContent>
              </Tooltip>
            ))}
          </nav>

          {/* User Menu */}
          <div className="flex items-center gap-2">
            {user.name && (
              <span className="text-sm text-muted-foreground hidden sm:inline">
                {user.name}
              </span>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => logout()}
                  className="gap-2"
                >
                  <LogOut className="h-4 w-4" />
                  <span className="hidden lg:inline">Sign Out</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Sign out of your account</p>
              </TooltipContent>
            </Tooltip>

            {/* Mobile Menu Toggle */}
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? (
                <X className="h-5 w-5" />
              ) : (
                <Menu className="h-5 w-5" />
              )}
            </Button>
          </div>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <nav className="md:hidden mt-4 pb-4 border-t pt-4">
            <div className="flex flex-col gap-2">
              {visibleItems.map((item) => (
                <Link key={item.path} href={item.path}>
                  <Button
                    variant={isActive(item.path) ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setMobileMenuOpen(false)}
                    className={cn(
                      "w-full justify-start gap-3",
                      isActive(item.path) && "bg-blue-600 hover:bg-blue-700"
                    )}
                  >
                    {item.icon}
                    <div className="flex flex-col items-start">
                      <span className="font-medium">{item.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {item.description}
                      </span>
                    </div>
                  </Button>
                </Link>
              ))}
            </div>
          </nav>
        )}
      </div>
    </header>
  );
}
