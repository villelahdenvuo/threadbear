// Which panel layout the window shows: the one shared by everything, or a
// project's own (Swift's PanelLayouts, Ville 13 Nov). Settings › General ›
// Panel layout picks the default for every project, and View › Panel Layout
// picks it for the project in front. A project with its own layout and none
// saved yet starts from a copy of the shared one. Threads in no project use
// the shared layout. Kept in desktop-settings.json, like the shared layout.
use crate::app::Threadbear;
use crate::settings::Saved;
use crate::shell::{self, SidebarMode, MAIN, THREADS};
use threadbear_dock::{DockDrop, DockEdge, DockLayout, DockNode};

/// `PanelLayouts.Mode`, as the saved raw values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    Shared,
    PerProject,
}

impl Mode {
    pub(crate) const ALL: [Mode; 2] = [Mode::Shared, Mode::PerProject];

    fn parse(raw: Option<&str>) -> Option<Mode> {
        match raw? {
            "shared" => Some(Mode::Shared),
            "perProject" => Some(Mode::PerProject),
            _ => None,
        }
    }

    fn raw(self) -> &'static str {
        match self {
            Mode::Shared => "shared",
            Mode::PerProject => "perProject",
        }
    }

    pub(crate) fn title(self) -> &'static str {
        match self {
            Mode::Shared => "Shared by all projects",
            Mode::PerProject => "Each project has its own",
        }
    }
}

/// The default for every project without a pick of its own.
pub(crate) fn default_mode(saved: &Saved) -> Mode {
    Mode::parse(saved.panel_layout_mode.as_deref()).unwrap_or(Mode::Shared)
}

/// A project's own pick, or None when it follows the default.
pub(crate) fn pick(saved: &Saved, project: &str) -> Option<Mode> {
    Mode::parse(saved.project_panel_layout_modes.as_ref()?.get(project).map(String::as_str))
}

pub(crate) fn mode_for(saved: &Saved, project: &str) -> Mode {
    pick(saved, project).unwrap_or_else(|| default_mode(saved))
}

/// Whose layout a project shows: its own id, or None for the shared one.
pub(crate) fn owner(saved: &Saved, project: Option<&str>) -> Option<String> {
    project.filter(|p| mode_for(saved, p) == Mode::PerProject).map(str::to_owned)
}

/// The layout saved for an owner (None: the shared one), if any.
pub(crate) fn load(saved: &Saved, owner: Option<&str>) -> Option<DockLayout> {
    let value = match owner {
        Some(owner) => saved.project_panel_layouts.as_ref()?.get(owner)?,
        None => saved.dock_layout.as_ref()?,
    };
    serde_json::from_value(value.clone()).ok()
}

/// Saves the dock's layout as an owner's.
pub(crate) fn save(saved: &mut Saved, owner: Option<&str>, layout: &DockLayout) {
    let Ok(value) = serde_json::to_value(layout) else { return };
    match owner {
        Some(owner) => {
            saved.project_panel_layouts.get_or_insert_with(Default::default).insert(owner.to_owned(), value);
        }
        None => saved.dock_layout = Some(value),
    }
}

/// `next`, as a swap from `from` should show it (`WindowDock.carrying`): the
/// threads list keeps its width, and threads opened in panels of their own
/// and panels in windows of their own stay open, as they belong to the
/// window rather than to a project.
pub(crate) fn carrying(from: &DockLayout, next: DockLayout) -> DockLayout {
    let mut next = shell::make_layout(serde_json::to_value(&next).ok().as_ref());
    for float in &from.floating {
        if !next.contains(&float.panel) {
            next.floating.push(float.clone());
        }
    }
    for panel in from.panels() {
        if crate::thread_panels::pinned_thread(&panel).is_some() && !next.contains(&panel) {
            match next.group_containing(MAIN) {
                Some(main) => next.add(&panel, DockDrop::edge(main.id.clone(), DockEdge::Right)),
                None => next.add(&panel, DockDrop::window(DockEdge::Right)),
            }
        }
    }
    if let Some(width) = sidebar_share(from) {
        if let DockNode::Split(split) = &mut next.root {
            let at = split.children.iter().position(|c| matches!(c, DockNode::Group(g) if g.panels.iter().any(|p| p == THREADS)));
            if let Some(i) = at.filter(|_| split.axis == threadbear_dock::SplitAxis::Horizontal && split.fractions.len() == split.children.len() && split.children.len() > 1) {
                let rest = 1. - split.fractions[i];
                let scale = if rest > 0. { (1. - width) / rest } else { 0. };
                split.fractions = split.fractions.iter().enumerate().map(|(n, f)| if n == i { width } else { f * scale }).collect();
            }
        }
    }
    next
}

/// The threads list's share of the window's width, when it sits along the
/// top of the window's own split.
fn sidebar_share(layout: &DockLayout) -> Option<f64> {
    let DockNode::Split(split) = &layout.root else { return None };
    if split.axis != threadbear_dock::SplitAxis::Horizontal || split.fractions.len() != split.children.len() {
        return None;
    }
    let i = split.children.iter().position(|c| matches!(c, DockNode::Group(g) if g.panels.iter().any(|p| p == THREADS)))?;
    Some(split.fractions[i])
}

/// What the main panel shows, as far as layouts go (`LayoutContext`):
/// `Keep` for a new thread and the home pages, which leave the layout as it
/// is rather than swap it twice on the way to another thread.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Context {
    Keep,
    Shared,
    Project(String),
}

impl Threadbear {
    pub(crate) fn layout_context(&self) -> Context {
        if let Some(project) = &self.projects.open {
            return Context::Project(project.clone());
        }
        if self.home_page().is_some() && self.mode != SidebarMode::Inbox {
            return Context::Keep;
        }
        let Some(thread) = self.selected.as_ref().and_then(|id| self.threads.get(id)) else { return Context::Keep };
        let known: Vec<&str> = self.projects.list.iter().map(|p| p.id.as_str()).collect();
        match thread.projects.iter().flatten().find(|p| known.is_empty() || known.contains(&p.id.as_str())) {
            Some(project) => Context::Project(project.id.clone()),
            None => Context::Shared,
        }
    }

    /// The project View › Panel Layout picks for, with its title.
    pub(crate) fn layout_project(&self) -> Option<(String, String)> {
        let Context::Project(id) = self.layout_context() else { return None };
        let title = self.projects.list.iter().find(|p| p.id == id).map(|p| p.title.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| "This Project".to_owned());
        Some((id, title))
    }

    /// Swaps the dock to the layout the context's project uses, sliding the
    /// panels across (`followLayoutContext`). Checked each frame, so every
    /// way of getting to a thread or a project's page follows it.
    pub(crate) fn follow_layout_context(&mut self, cx: &mut gpui_kit::Context<Self>) {
        let project = self.layout_project().map(|(id, _)| id);
        if project != self.layout_menu_project {
            self.layout_menu_project = project;
            self.menus_stale = true;
        }
        let owner = match self.layout_context() {
            Context::Keep => return,
            Context::Shared => None,
            Context::Project(id) => owner(&self.settings.saved, Some(&id)),
        };
        if owner == self.layout_owner {
            return;
        }
        let from = self.dock.read(cx).layout().clone();
        // A project's first own layout is a copy of the shared one.
        let next = load(&self.settings.saved, owner.as_deref()).or_else(|| load(&self.settings.saved, None)).unwrap_or_else(shell::default_layout);
        self.layout_owner = owner;
        let next = carrying(&from, next);
        self.dock.update(cx, |m, cx| m.set_layout(next, cx));
    }

    /// View › Panel Layout: the project in front uses the shared layout or
    /// its own from now on.
    pub(crate) fn set_layout_pick(&mut self, mode: Mode, cx: &mut gpui_kit::Context<Self>) {
        let Some((project, _)) = self.layout_project() else { return };
        self.settings.saved.project_panel_layout_modes.get_or_insert_with(Default::default).insert(project, mode.raw().to_owned());
        self.save_settings_soon(cx);
        self.follow_layout_context(cx);
        self.menus_stale = true;
        cx.notify();
    }

    /// Settings, or the menu's Make Default: the default for every project
    /// without a pick of its own. A project's own pick stays.
    pub(crate) fn set_layout_default(&mut self, mode: Mode, cx: &mut gpui_kit::Context<Self>) {
        self.settings.saved.panel_layout_mode = Some(mode.raw().to_owned());
        self.save_settings_soon(cx);
        self.follow_layout_context(cx);
        self.menus_stale = true;
        cx.notify();
    }

    /// View › Panel Layout's items: Shared Layout and Own Layout for the
    /// project in front, the one it uses ticked and the default starred, and
    /// the default set from the same menu (AGENTS.md).
    pub(crate) fn panel_layout_menu(&self) -> Vec<shell::MenuEntry> {
        use shell::{Command, MenuEntry};
        let project = self.layout_project();
        let fallback = default_mode(&self.settings.saved);
        let mode = project.as_ref().map_or(Mode::Shared, |(id, _)| mode_for(&self.settings.saved, id));
        let star = |title: String, m: Mode| if m == fallback { format!("{title} ★") } else { title };
        let own = project.as_ref().map_or_else(|| "Own Layout for This Project".to_owned(), |(_, title)| format!("Own Layout for {title}"));
        vec![
            MenuEntry::Item { title: star("Shared Layout".into(), Mode::Shared), command: Command::LayoutShared, enabled: project.is_some(), checked: project.is_some() && mode == Mode::Shared },
            MenuEntry::Item { title: star(own, Mode::PerProject), command: Command::LayoutOwn, enabled: project.is_some(), checked: project.is_some() && mode == Mode::PerProject },
            MenuEntry::Separator,
            MenuEntry::Item {
                title: if mode == Mode::Shared { "Make Shared the Default" } else { "Make Own Layout the Default" }.into(),
                command: Command::LayoutMakeDefault,
                enabled: project.is_some() && mode != fallback,
                checked: false,
            },
        ]
    }

    /// Make Default from View › Panel Layout: the project in front's mode.
    pub(crate) fn make_layout_default(&mut self, cx: &mut gpui_kit::Context<Self>) {
        let Some((id, _)) = self.layout_project() else { return };
        let mode = mode_for(&self.settings.saved, &id);
        self.set_layout_default(mode, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use threadbear_dock::{DockGroup, DockSplit, SplitAxis};

    fn saved(json: serde_json::Value) -> Saved {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn a_project_follows_the_default_unless_it_picked() {
        let s = saved(serde_json::json!({}));
        assert_eq!(default_mode(&s), Mode::Shared);
        assert_eq!(owner(&s, Some("p1")), None, "shared by default");
        let s = saved(serde_json::json!({ "panelLayoutMode": "perProject", "projectPanelLayoutModes": { "p2": "shared" } }));
        assert_eq!(owner(&s, Some("p1")), Some("p1".into()));
        assert_eq!(owner(&s, Some("p2")), None, "its own pick wins");
        assert_eq!(owner(&s, None), None, "no project, the shared one");
    }

    #[test]
    fn layouts_save_to_their_owner() {
        let mut s = Saved::default();
        let shared = shell::default_layout();
        save(&mut s, None, &shared);
        let mut own = shared.clone();
        own.add("threadbear.terminal", DockDrop::window(DockEdge::Bottom));
        save(&mut s, Some("p1"), &own);
        assert!(load(&s, Some("p1")).unwrap().contains("threadbear.terminal"));
        assert!(!load(&s, None).unwrap().contains("threadbear.terminal"));
        assert!(load(&s, Some("p2")).is_none(), "none yet: a copy of the shared one is used");
    }

    #[test]
    fn a_swap_keeps_the_threads_list_width_and_threads_in_their_own_panels() {
        let group = |id: &str, panel: &str| DockNode::Group(DockGroup::new(id, vec![panel.to_string()], None));
        let from_root = DockNode::Split(DockSplit::new("window", SplitAxis::Horizontal, vec![group("sidebar", THREADS), group("main", MAIN), group("t", &crate::thread_panels::thread_panel("abc"))], Some(vec![0.4, 0.4, 0.2])));
        let from = DockLayout::new(from_root, [], vec![]);
        let next = carrying(&from, shell::default_layout());
        assert!(next.contains(&crate::thread_panels::thread_panel("abc")), "the thread's own panel stays");
        assert_eq!(sidebar_share(&next).map(|w| (w * 100.).round()), Some(40.), "the threads list keeps its width");
    }
}
