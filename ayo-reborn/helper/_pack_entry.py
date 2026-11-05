# PyInstaller entry for the packaged listener.
# Runs the rita_listener package's __main__ so all import paths stay normal.
import runpy

runpy.run_module('rita_listener', run_name='__main__')
