class Gallium < Formula
  desc "Read-only Google Tag Manager container analysis CLI"
  homepage "https://github.com/tyssejc/gallium"
  url "https://github.com/tyssejc/gallium/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "REPLACE_AFTER_FIRST_RELEASE_TARBALL"
  license "MIT"
  depends_on "oven-sh/bun/bun"

  def install
    libexec.install Dir["*"]
    system "#{Formula["bun"].opt_bin}/bun", "install", "--cwd", libexec, "--production"
    (bin/"gallium").write <<~SH
      #!/bin/bash
      exec "#{Formula["bun"].opt_bin}/bun" run "#{libexec}/bin/gallium.ts" "$@"
    SH
    chmod 0755, bin/"gallium"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/gallium --version")
  end
end
