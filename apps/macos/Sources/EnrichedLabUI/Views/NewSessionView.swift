import AppKit
import EnrichedLabKit
import SwiftUI

/// A new session: the project folder, where it runs, the model, and the first task. Return starts it.
struct NewSessionView: View {
	@Environment(AppModel.self) private var app
	@Environment(\.openSettings) private var openSettings
	@State private var task = ""
	@State private var model: String?
	@State private var starting: String?
	@FocusState private var focused: Bool
	@AppStorage("recentFolders") private var recentData = Data()

	var body: some View {
		@Bindable var app = app
		// In a scroll view sized to the window, so a long task or a short window scrolls instead of growing the window.
		GeometryReader { proxy in
			ScrollView {
				form.frame(maxWidth: .infinity, minHeight: proxy.size.height)
			}
			.scrollBounceBehavior(.basedOnSize)
		}
		.navigationTitle("New Session")
		.onAppear {
			focused = true
			model = nil
		}
	}

	private var form: some View {
		VStack(spacing: 0) {
			Spacer(minLength: 40)
			VStack(alignment: .leading, spacing: 18) {
				Text("New Session").font(.system(size: 26, weight: .semibold))
				VStack(alignment: .leading, spacing: 10) {
					row("Project") { folderMenu }
					row("Runs on") { placeMenu }
					row("Model") { modelMenu }
				}
				VStack(alignment: .leading, spacing: 10) {
					TextField("What should the agent work on?", text: $task, axis: .vertical)
						.textFieldStyle(.plain)
						.font(.system(size: 15))
						.lineLimit(3 ... 14)
						.focused($focused)
						.onSubmit(start)
						.onKeyPress(.return, phases: .down) { press in
							guard press.modifiers.contains(.shift) else { return .ignored }
							task += "\n"
							return .handled
						}
					HStack {
						if let starting {
							ProgressView().controlSize(.small)
							Text(starting).foregroundStyle(.secondary)
						} else {
							Text(placeNote).font(.callout).foregroundStyle(.secondary)
						}
						Spacer()
						Button("Start", action: start)
							.buttonStyle(.borderedProminent)
							.keyboardShortcut(.defaultAction)
							.disabled(starting != nil || !app.connected)
					}
				}
				.padding(14)
				.glass(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
				if app.connected, app.allowed(site: site).isEmpty { noModel }
				ForEach(app.places.filter { $0.site.map { !$0.signedIn } ?? false }) { lab in
					HStack(spacing: 4) {
						Button("Sign in to \(lab.title)") { if let name = lab.site?.name { Task { _ = await app.signIn(name) } } }
							.buttonStyle(.link)
						Text("to work in its sandbox or use its models.").foregroundStyle(.secondary)
					}
					.font(.callout)
				}
			}
			.frame(maxWidth: 640)
			.padding(.horizontal, 32)
			Spacer(minLength: 40)
			Spacer(minLength: 40)
		}
	}

	/// No model can run this session yet: what to do about it, and that a task can wait.
	private var noModel: some View {
		HStack(alignment: .top, spacing: 16) {
			VStack(alignment: .leading, spacing: 4) {
				Text(app.models.isEmpty ? "No model yet." : "No model may work in \(place.title) yet.").fontWeight(.semibold)
				Text("Sign in to a lab, use your ChatGPT plan or a key, or run an open model on this Mac. A task you write now waits in the session until then.")
					.foregroundStyle(.secondary)
			}
			Spacer(minLength: 0)
			Button("Set Up a Model…") {
				app.showSettingsTab = .models
				openSettings()
			}
		}
		.font(.callout)
		.padding(.horizontal, 4)
	}

	private func row(_ label: String, @ViewBuilder content: () -> some View) -> some View {
		HStack(spacing: 12) {
			Text(label).foregroundStyle(.secondary).frame(width: 64, alignment: .leading)
			content()
			Spacer()
		}
	}

	// MARK: Project

	private var recent: [URL] {
		((try? JSONDecoder().decode([String].self, from: recentData)) ?? []).map { URL(fileURLWithPath: $0) }.filter { FileManager.default.fileExists(atPath: $0.path) }
	}

	private var folderMenu: some View {
		Menu {
			Button("Choose a Folder…") { chooseFolder() }
			if !recent.isEmpty {
				Section("Recent") {
					ForEach(recent, id: \.self) { url in Button(folderName(url.path)) { app.newFolder = url } }
				}
			}
			let projects = app.projects.prefix(8).map(\.folder).filter { path in !recent.contains { $0.path == path } }
			if !projects.isEmpty {
				Section("From Your Sessions") {
					ForEach(projects, id: \.self) { path in Button(folderName(path)) { app.newFolder = URL(fileURLWithPath: path) } }
				}
			}
		} label: {
			Label(app.newFolder.map { folderName($0.path) } ?? "Choose", systemImage: "folder")
		}
		.menuStyle(.button)
		.fixedSize()
		.help(app.newFolder.map { shortPath($0.path) } ?? "")
	}

	private func chooseFolder() {
		let panel = NSOpenPanel()
		panel.canChooseDirectories = true
		panel.canChooseFiles = false
		panel.canCreateDirectories = true
		panel.prompt = "Use Folder"
		panel.message = "The agent works in this folder. It can read and change files here, and nowhere else without asking."
		guard panel.runModal() == .OK, let url = panel.url else { return }
		app.newFolder = url
	}

	private func remember(_ url: URL) {
		var list = recent.map(\.path).filter { $0 != url.path }
		list.insert(url.path, at: 0)
		recentData = (try? JSONEncoder().encode(Array(list.prefix(8)))) ?? Data()
	}

	// MARK: Place

	private var place: Place { app.place(of: app.newPlace) }

	private var placeMenu: some View {
		Menu {
			ForEach(app.places) { place in
				Button {
					if let site = place.site, !site.signedIn { Task { _ = await app.signIn(site.name) } }
					app.newPlace = place.id
				} label: {
					let title = place.isLocal ? place.title : "\(place.title) sandbox"
					if place.id == app.newPlace { Label(title, systemImage: "checkmark") } else { Text(title) }
				}
				.disabled(!place.isLocal && place.site?.signedIn == true && !place.ready)
			}
			Divider()
			Button("Add a Lab…") { app.joining = JoinRequest() }
		} label: {
			HStack(spacing: 6) {
				PlaceDot(place: place)
				Text(place.isLocal ? place.title : "\(place.title) sandbox")
			}
		}
		.menuStyle(.button)
		.fixedSize()
	}

	private var placeNote: String {
		if place.isLocal { return "Runs on This Mac, contained to the project folder." }
		if let site = place.site, !site.signedIn { return "Sign in to \(place.title) to work there." }
		return "Runs on Linux in the \(place.title) sandbox. A git repository comes along."
	}

	// MARK: Model

	private var site: String? { place.isLocal ? nil : place.id }

	private var chosen: String? {
		let allowed = app.allowed(site: site)
		if let model, allowed.contains(where: { $0.ref == model }) { return model }
		if let preferred = app.defaultModel, allowed.contains(where: { $0.ref == preferred }) { return preferred }
		// A lab session starts on the lab's own model.
		if let site, let labModel = allowed.first(where: { $0.provider == site }) { return labModel.ref }
		return allowed.first?.ref
	}

	private var modelMenu: some View {
		Menu {
			ForEach(modelGroups(app.allowed(site: site))) { group in
				Section(group.label) {
					ForEach(group.models) { m in
						Button {
							model = m.ref
						} label: {
							if m.ref == chosen { Label(m.label, systemImage: "checkmark") } else { Text(m.label) }
						}
					}
				}
			}
			Divider()
			Button("Model Services…") {
				app.showSettingsTab = .models
				openSettings()
			}
		} label: {
			if let ref = chosen, let info = app.model(ref) {
				Label(info.label, systemImage: info.where.isPrivate ? "lock" : "cloud")
			} else {
				Text(app.models.isEmpty ? "No models yet" : "Choose a model")
			}
		}
		.menuStyle(.button)
		.fixedSize()
		.help(chosen.flatMap { app.model($0) }.map { whereNote($0.where) } ?? "Add a model service, sign in to a lab, or run a model on this Mac.")
	}

	// MARK: Start

	private func start() {
		let text = task.trimmingCharacters(in: .whitespacesAndNewlines)
		guard starting == nil, let folder = app.newFolder else { return }
		if let site = place.site, !site.signedIn {
			Task { _ = await app.signIn(site.name) }
			return
		}
		starting = place.isLocal ? "Starting…" : "Moving into the \(place.title) sandbox…"
		remember(folder)
		Task {
			let made = await app.create(folder: folder, place: app.newPlace, model: chosen, prompt: text.isEmpty ? nil : text)
			starting = nil
			if made != nil { task = "" }
		}
	}
}
